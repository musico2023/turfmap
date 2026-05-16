/**
 * DataForSEO-backed citation checker.
 *
 * Replaces the BrightLocal Data API NAP audit path for tiers that
 * can't justify the BL cost (Free TurfScan, $197 Visibility Audit,
 * any one-time buyer). Same `NapAuditFindings` output shape, so the
 * dashboard + AI Coach + roadmap generator consume it unchanged.
 *
 * Mechanism: for each directory in the audit set, send a Google
 * SERP query with a `site:{domain}` filter constrained to the
 * business name + city. Parse the top result — if it exists, the
 * listing exists. Snippet text → best-effort NAP extraction →
 * compare to canonical via lib/citations/napCompare.
 *
 * Why Google SERP scrape vs direct directory APIs:
 *   - Universal: works for any directory Google indexes (Yelp, BBB,
 *     Apple Maps, Foursquare, BingPlaces, etc.) — no per-directory
 *     integration to write/maintain.
 *   - Cheap: DFS Live Advanced is $0.002/req; one query per
 *     directory at ~12 directories = $0.024 per audit. ~30x cheaper
 *     than BL Data API at $0.05/req × 15 dirs = $0.75.
 *   - Tolerant: site: filters survive Google ranking changes; we
 *     just look at whether a result was returned, not its rank.
 *
 * Trade-offs vs BrightLocal Data API:
 *   - Lower NAP-extraction accuracy. Snippets are short; we may miss
 *     full-address mismatches that BL's structured API would catch.
 *     napCompare.classifyCitation is deliberately conservative —
 *     "unverified" is preferred over false "mismatch."
 *   - No auto-resync / auto-fix. This is pure check-only. Operator
 *     still needs BL Citation Builder for fixes (Pulse+ tier).
 *   - No sibling-location dedup (multi-location brands). Planned
 *     for v2; today every directory is checked against canonical
 *     primary location only.
 */

import type { NapAuditFindings, NapAuditCitation, NapAuditInconsistency, NapAuditMissing } from '@/lib/supabase/types';
import { classifyCitation, nameMatches, addressMatches, phoneMatches, type CitationStatus } from './napCompare';
import type { DfsDirectory } from './directories';

const DFS_BASE_URL = 'https://api.dataforseo.com';
const DFS_LIVE_ADVANCED = '/v3/serp/google/organic/live/advanced';

/** Max concurrent DFS requests during a citation audit. 12 directories
 *  at concurrency 6 = 2 batches sequentially = ~3-5s total. */
const CITATION_CONCURRENCY = 6;

/** Per-call DFS retry: same retryable-codes list as the grid scanner.
 *  IP-not-whitelisted blips on dual-stack networks clear with one retry. */
const DFS_RETRYABLE_TASK_CODES = new Set<number>([40207]);
const DFS_MAX_ATTEMPTS = 2;

/** Canonical business profile we audit against. Subset of the
 *  BL BusinessProfile shape — phone is optional because some buyers
 *  haven't filled it in, in which case we just skip phone matching.
 *  Lat/lng are optional; when present they enable the more accurate
 *  GBP local_pack probe (search centered on the business's coords
 *  with a 1km radius virtually guarantees their GBP ranks at the
 *  top of the local pack if one exists). When absent the GBP probe
 *  falls back to location_name string. */
export type CitationBusinessProfile = {
  name: string;
  street_address: string;
  city: string;
  region: string;
  postcode: string;
  country: string;
  telephone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

/** A sibling location of the same brand — used by sibling-aware
 *  classification (see runDfsCitationAudit). Same shape as the BL
 *  client's SiblingLocation type so callers can pass the same data
 *  to either provider.
 *
 *  Why this matters: a multi-location brand (Kidcrew with Wychwood +
 *  Don Mills, a contractor with 3 city offices, etc.) gets ONE audit
 *  per location. Without sibling awareness, the Don Mills audit
 *  flags BBB as "wrong address" when BBB's listing is actually
 *  Wychwood's correct address. False positive that erodes operator
 *  trust the moment they recognize their own sibling's data.
 *
 *  With sibling awareness: BBB's listing matches Wychwood's NAP
 *  → classify as `sibling_match` (NOT mismatch), add to the
 *  Don Mills audit's `missing` list with `occupied_by_sibling`
 *  populated so the AI Coach can recommend "add Don Mills alongside
 *  the existing Wychwood listing" instead of "fix Don Mills's wrong
 *  NAP." */
export type SiblingLocation = CitationBusinessProfile & {
  /** Optional human-readable label like "Wychwood" or "Don Mills"
   *  for surfacing in the Fix List. NULL when the sibling has no
   *  meaningful label (rare). */
  label?: string | null;
};

/** What we extract from one DFS SERP query for one directory. */
type DirectoryProbeResult = {
  directory: DfsDirectory;
  /** First organic result URL pointing into the directory's domain,
   *  or null if the SERP returned no `site:{domain}` matches. */
  url: string | null;
  /** Top result's title — usually contains the business name. */
  found_name: string | null;
  /** Top result's snippet — best source for address/phone fragments. */
  found_snippet: string | null;
  /** DFS task cost in dollars for this single call. Aggregated for the
   *  per-audit cost estimate. */
  cost_dollars: number;
  /** Captured if the DFS call errored. Doesn't fail the audit; that
   *  directory just classifies as 'unverified'. */
  error: string | null;
};

function getDfsAuthHeader(): string {
  // Same env vars as lib/dataforseo/client.ts. Centralizing this in
  // a shared helper is a follow-up — for now duplication is fine.
  const login = process.env.DFS_LOGIN;
  const password = process.env.DFS_PASSWORD;
  if (!login || !password) {
    throw new Error(
      'DFS_LOGIN and DFS_PASSWORD must be set in env (see .env.local).'
    );
  }
  const token = Buffer.from(`${login}:${password}`).toString('base64');
  return `Basic ${token}`;
}

type DfsTask = {
  id?: string;
  status_code: number;
  status_message?: string;
  cost?: number;
  result?: Array<{
    items?: Array<Record<string, unknown>>;
  }>;
};
type DfsResponse = {
  status_code: number;
  status_message?: string;
  tasks?: DfsTask[];
};

/** Send one DFS Live Advanced SERP request. Returns the single task
 *  object. Thin wrapper — error handling per-directory happens in the
 *  caller so a single bad probe doesn't bring down the audit. */
async function postSerpTask(body: Record<string, unknown>): Promise<DfsTask> {
  const res = await fetch(`${DFS_BASE_URL}${DFS_LIVE_ADVANCED}`, {
    method: 'POST',
    headers: {
      Authorization: getDfsAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([body]),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable>');
    throw new Error(`DFS HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as DfsResponse;
  if (json.status_code !== 20000) {
    throw new Error(`DFS gateway ${json.status_code}: ${json.status_message ?? ''}`);
  }
  if (!json.tasks?.[0]) {
    throw new Error('DFS returned no tasks');
  }
  return json.tasks[0];
}

/** Bounded-concurrency map — keeps DFS request rate within their
 *  per-second limit while still parallelizing across directories. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const run = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(run());
  }
  await Promise.all(workers);
  return out;
}

/** Build the SERP query string for one directory probe.
 *  Form: `site:{domain} "{name}" {city}`. Quotes around the name
 *  force an exact-match phrase search; the city term is a soft
 *  filter that helps Google rank the right location-specific listing
 *  first. Postcode is omitted — Google ignores it on most directory
 *  domains and it just adds query length. */
function buildSerpQuery(
  business: CitationBusinessProfile,
  directory: DfsDirectory
): string {
  return `site:${directory.domain} "${business.name}" ${business.city}`;
}

/** Map BusinessProfile.country to a DFS location_name string. DFS uses
 *  a "City,Region,Country" format with the country name spelled out. */
function dfsLocationFromBusiness(business: CitationBusinessProfile): string {
  // ISO-3 country code → DFS expected name.
  const countryMap: Record<string, string> = {
    USA: 'United States',
    CAN: 'Canada',
    GBR: 'United Kingdom',
    AUS: 'Australia',
  };
  const countryName = countryMap[business.country] ?? 'United States';
  return `${business.city},${business.region},${countryName}`;
}

/** Probe one directory. Dispatches to the right strategy based on
 *  directory.probe — `site_serp` (default, site:filter SERP scrape)
 *  or `local_pack` (Google organic query, parse local_pack items;
 *  used for Google Business Profile). Captures any error inline —
 *  never throws to the caller. */
async function probeDirectory(
  business: CitationBusinessProfile,
  directory: DfsDirectory
): Promise<DirectoryProbeResult> {
  if (directory.probe === 'local_pack') {
    return probeDirectoryViaLocalPack(business, directory);
  }
  return probeDirectoryViaSiteSerp(business, directory);
}

/** Site-filter SERP probe — the default path for non-Google
 *  directories (Yelp, BBB, Facebook, Apple Maps, etc.). Sends one
 *  Google query of the form `site:{domain} "{name}" {city}` and
 *  parses the top organic result that matches the directory's
 *  domain (and isn't a search-results URL). */
async function probeDirectoryViaSiteSerp(
  business: CitationBusinessProfile,
  directory: DfsDirectory
): Promise<DirectoryProbeResult> {
  const body = {
    keyword: buildSerpQuery(business, directory),
    location_name: dfsLocationFromBusiness(business),
    language_code: 'en',
    device: 'desktop',
    // Cap depth at 10 results — citation listings rank well above
    // that floor on direct site: filters; no value in fetching 100.
    depth: 10,
    tag: `citation:${directory.id}`,
  };

  let task: DfsTask | null = null;
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= DFS_MAX_ATTEMPTS; attempt++) {
    try {
      task = await postSerpTask(body);
      if (task.status_code === 20000) break;
      if (!DFS_RETRYABLE_TASK_CODES.has(task.status_code)) break;
      if (attempt < DFS_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  if (!task || task.status_code !== 20000) {
    return {
      directory,
      url: null,
      found_name: null,
      found_snippet: null,
      cost_dollars: task?.cost ?? 0,
      error: lastError ?? `DFS task ${task?.status_code}: ${task?.status_message ?? 'unknown'}`,
    };
  }

  // Pick the first organic result whose URL contains the directory
  // domain. Google sometimes injects featured-snippet / ad results
  // ahead of organics — filter by the domain to skip those.
  const items = (task.result?.[0]?.items ?? []) as Array<{
    type?: string;
    url?: string;
    title?: string;
    description?: string;
    domain?: string;
  }>;
  // Filter to organic results on the directory's domain, EXCLUDING
  // search-results / index-page URLs. Search pages like
  // `yelp.com/search?find_desc=...` aren't real listings — they're
  // Yelp's own search interface, which Google sometimes ranks above
  // actual profile pages when no exact match exists. Counting them as
  // citations is a false positive (smoke test surfaced this for Yelp).
  const SEARCH_URL_PATTERNS = /\/(search|find|finder|browse|sitemap)|[?&](q|query|find_desc|find_near|find_loc|location|search)=/i;
  // probe='site_serp' directories ALWAYS have a domain set — types
  // make it optional only because probe='local_pack' (GBP) omits it.
  // The dispatcher upstream guarantees we never reach this branch
  // without a domain; assert here so the compiler narrows the type
  // for the rest of the function.
  if (!directory.domain) {
    return {
      directory,
      url: null,
      found_name: null,
      found_snippet: null,
      cost_dollars: task.cost ?? 0,
      error: 'site_serp probe invoked without a domain',
    };
  }
  const dirRoot = directory.domain.replace(/^www\./, '').split('/')[0];

  const match = items.find((it) => {
    if (it.type !== 'organic') return false;
    if (!it.url) return false;
    // Compare against the directory's root domain; tolerate www. and
    // path variants. e.g., "https://www.yelp.com/biz/..." matches "yelp.com".
    if (!it.url.toLowerCase().includes(dirRoot)) return false;
    // Reject directory-search-page URLs.
    if (SEARCH_URL_PATTERNS.test(it.url)) return false;
    return true;
  });

  return {
    directory,
    url: match?.url ?? null,
    found_name: match?.title ?? null,
    found_snippet: match?.description ?? null,
    cost_dollars: task.cost ?? 0,
    error: null,
  };
}

/** Local-pack probe — for Google Business Profile. Sends a plain
 *  organic SERP query (no site: filter) for the business name +
 *  city, then parses the `local_pack` items in the response. Local
 *  pack items ARE GBP listings — each one represents a Google
 *  Business Profile, with structured title + phone + url + cid
 *  (Google's stable place id).
 *
 *  Centering: when business has lat/lng we pass them via
 *  location_coordinate with a 1km radius. That virtually guarantees
 *  the buyer's own GBP ranks at the top of the local pack if one
 *  exists, since proximity is the dominant local-pack ranking
 *  factor at 1km. Without lat/lng we fall back to location_name
 *  (city/region/country) which still works but with slightly looser
 *  proximity targeting.
 *
 *  Why this couldn't be done as a site_serp probe: Google's site:
 *  filter rejects path-based queries (`site:google.com/maps` is
 *  invalid syntax). And bare `site:google.com` returns the whole
 *  Google index. Local pack parsing is the canonical way to
 *  surface GBP listings programmatically. */
async function probeDirectoryViaLocalPack(
  business: CitationBusinessProfile,
  directory: DfsDirectory
): Promise<DirectoryProbeResult> {
  // Centerable when lat/lng are present (typical for clients via
  // /api/clients/[id]/locations); fall back to location_name string
  // when they aren't.
  const hasCoords =
    typeof business.latitude === 'number' &&
    typeof business.longitude === 'number';
  const body: Record<string, unknown> = {
    keyword: `${business.name} ${business.city}`,
    language_code: 'en',
    device: 'desktop',
    depth: 10,
    tag: `citation:${directory.id}`,
  };
  if (hasCoords) {
    // "lat,lng,radius_km" — same shape lib/dataforseo/client.ts uses.
    // 1km radius centers tightly on the storefront.
    body.location_coordinate = `${business.latitude},${business.longitude},1`;
  } else {
    body.location_name = dfsLocationFromBusiness(business);
  }

  let task: DfsTask | null = null;
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= DFS_MAX_ATTEMPTS; attempt++) {
    try {
      task = await postSerpTask(body);
      if (task.status_code === 20000) break;
      if (!DFS_RETRYABLE_TASK_CODES.has(task.status_code)) break;
      if (attempt < DFS_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  if (!task || task.status_code !== 20000) {
    return {
      directory,
      url: null,
      found_name: null,
      found_snippet: null,
      cost_dollars: task?.cost ?? 0,
      error: lastError ?? `DFS task ${task?.status_code}: ${task?.status_message ?? 'unknown'}`,
    };
  }

  // Find a GBP item. Google returns different SERP elements for
  // different query types:
  //   - Category searches ("home builder Toronto") → `local_pack`
  //     items at the top of the SERP, ≤3 ranked GBP listings
  //   - Business-name searches ("BVM Contracting Toronto") → a
  //     `knowledge_graph` panel (right-side business card) with the
  //     buyer's GBP info, no local_pack at all
  //   - Sometimes both, sometimes neither
  // Check BOTH locations so business-name probes catch the
  // knowledge-panel path that proximity-search probes might miss.
  // First match wins; nameMatches gates either path.
  const items = (task.result?.[0]?.items ?? []) as Array<{
    type?: string;
    title?: string;
    phone?: string;
    phone_number?: string;
    url?: string;
    website?: string;
    description?: string;
    snippet?: string;
    address?: string;
    cid?: string;
    place_id?: string;
  }>;
  // Both local_pack and knowledge_graph carry GBP info. Walk in
  // order: local_pack first (more reliable when present), fall
  // through to knowledge_graph when not.
  let match: (typeof items)[number] | undefined;
  for (const it of items) {
    if (it.type !== 'local_pack' && it.type !== 'knowledge_graph') continue;
    if (!nameMatches(business.name, it.title ?? null)) continue;
    match = it;
    break;
  }

  if (!match) {
    return {
      directory,
      url: null,
      found_name: null,
      found_snippet: null,
      cost_dollars: task.cost ?? 0,
      error: null,
    };
  }

  // Synthesize a "snippet" from whichever fields the matched element
  // exposed. local_pack items typically have phone + description;
  // knowledge_graph items typically have phone_number + address +
  // snippet. Cover both so the downstream extract* helpers + NAP
  // comparison have something to work with.
  const phone = match.phone ?? match.phone_number ?? '';
  const description = match.description ?? match.snippet ?? '';
  const addr = match.address ?? '';
  const syntheticSnippet = [phone, addr, description]
    .filter(Boolean)
    .join(' • ');

  return {
    directory,
    // Prefer a cid-based maps URL when DFS exposes one (stable
    // place identifier). Knowledge_graph items often expose
    // place_id instead — synthesize a maps URL from that. Fall back
    // to whatever url/website DFS returned.
    url: match.cid
      ? `https://maps.google.com/?cid=${match.cid}`
      : match.place_id
        ? `https://maps.google.com/?q=place_id:${match.place_id}`
        : match.url ?? match.website ?? null,
    found_name: match.title ?? null,
    found_snippet: syntheticSnippet || null,
    cost_dollars: task.cost ?? 0,
    error: null,
  };
}

/** Pull a phone number out of a free-text snippet. Returns null if no
 *  recognizable phone present. Greedy — picks the first plausible
 *  10-digit phone, since directories rarely list multiple phones in
 *  the snippet. */
function extractPhoneFromSnippet(snippet: string | null): string | null {
  if (!snippet) return null;
  // Match phone patterns: (XXX) XXX-XXXX, XXX-XXX-XXXX, XXX.XXX.XXXX,
  // +1 XXX..., etc.
  const re = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
  const m = snippet.match(re);
  return m?.[0] ?? null;
}

/** Pull a street-address-shaped fragment out of a free-text snippet.
 *  Heuristic: look for "<number> <one-or-more-words>" at the start of
 *  a sentence. Returns the whole matched fragment or null. */
function extractAddressFromSnippet(snippet: string | null): string | null {
  if (!snippet) return null;
  // Number + 1-6 words before a comma or period or end-of-string.
  const re = /\b(\d{1,6}\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,5})/;
  const m = snippet.match(re);
  return m?.[1] ?? null;
}

/** Aggregate cost + per-directory probe summary returned alongside the
 *  findings. Used by autoAudit.ts to stamp the nap_audits row with
 *  provider-specific cost info. */
export type DfsCitationAuditResult = {
  findings: NapAuditFindings;
  total_cost_dollars: number;
  per_directory_summary: Array<{
    directory_id: string;
    label: string;
    status: 'matched' | 'mismatch' | 'unverified' | 'missing';
    url: string | null;
    error: string | null;
  }>;
};

/** Decide whether a found listing's NAP fragments match one of the
 *  given sibling locations. Returns the matched sibling or null.
 *
 *  Match rule: same as classifyCitation's 'matched' path — name OR
 *  (phone OR address) must align. Since callers already passed the
 *  name-gate before this function fires, name match here is
 *  redundant; we just need a NAP signal. */
function findMatchingSibling(
  siblings: readonly SiblingLocation[],
  foundName: string | null,
  foundPhone: string | null,
  foundAddress: string | null
): SiblingLocation | null {
  for (const s of siblings) {
    if (!nameMatches(s.name, foundName)) continue;
    if (phoneMatches(s.telephone ?? null, foundPhone)) return s;
    if (addressMatches(s.street_address, foundAddress)) return s;
  }
  return null;
}

/**
 * Run a DFS-backed citation audit against the given directory set.
 *
 * Returns NapAuditFindings shaped for storage in nap_audits.findings
 * and downstream consumption by the dashboard + AI Coach.
 *
 * Sibling-aware: when `siblings` is non-empty, any listing whose NAP
 * matches a sibling (but not the canonical) is classified as
 * `sibling_match` instead of `mismatch`, and added to `missing` with
 * `occupied_by_sibling` populated. Pass an empty array (or omit) for
 * single-location buyers.
 *
 * Never throws — individual directory failures classify as
 * `missing` so a partial audit is more useful than no audit.
 */
export async function runDfsCitationAudit(
  business: CitationBusinessProfile,
  directories: readonly DfsDirectory[],
  siblings: readonly SiblingLocation[] = []
): Promise<DfsCitationAuditResult> {
  if (directories.length === 0) {
    return {
      findings: { citations: [], inconsistencies: [], missing: [] },
      total_cost_dollars: 0,
      per_directory_summary: [],
    };
  }

  const probes = await mapWithConcurrency(
    Array.from(directories),
    CITATION_CONCURRENCY,
    (d) => probeDirectory(business, d)
  );

  const citations: NapAuditCitation[] = [];
  const inconsistencies: NapAuditInconsistency[] = [];
  const missing: NapAuditMissing[] = [];
  const summary: DfsCitationAuditResult['per_directory_summary'] = [];
  let totalCost = 0;

  for (const probe of probes) {
    totalCost += probe.cost_dollars;

    if (probe.error || !probe.url) {
      // No listing found OR DFS errored. Both classify as
      // 'missing' from the operator's perspective — they don't
      // have a presence on this directory.
      missing.push({
        directory: probe.directory.id,
        priority: probe.directory.priority,
      });
      summary.push({
        directory_id: probe.directory.id,
        label: probe.directory.label,
        status: 'missing',
        url: null,
        error: probe.error,
      });
      continue;
    }

    // Listing exists — but first hard-gate on name match. If the
    // SERP returned a result whose title is clearly a different
    // business (smoke test surfaced this for Nextdoor — matched
    // "Ryan Meagher Mortgages" against "BVM Contracting" because
    // both share "Ryan" + "Toronto" tokens), reclassify as missing
    // rather than counting it as an unverified citation. Otherwise
    // the dashboard surfaces fake "listings on Nextdoor!" findings
    // that erode operator trust.
    if (!nameMatches(business.name, probe.found_name)) {
      missing.push({
        directory: probe.directory.id,
        priority: probe.directory.priority,
      });
      summary.push({
        directory_id: probe.directory.id,
        label: probe.directory.label,
        status: 'missing',
        url: null,
        error: `result name "${(probe.found_name ?? '').slice(0, 40)}" doesn't match canonical`,
      });
      continue;
    }

    // Name matched — extract NAP fragments and classify.
    const foundPhone = extractPhoneFromSnippet(probe.found_snippet);
    const foundAddress = extractAddressFromSnippet(probe.found_snippet);
    const canonicalStatus: CitationStatus = classifyCitation(
      {
        name: business.name,
        phone: business.telephone ?? null,
        address: business.street_address,
      },
      {
        name: probe.found_name,
        phone: foundPhone,
        address: foundAddress,
      }
    );

    // Sibling-aware override: if classifyCitation would have flagged
    // a mismatch BUT the found NAP actually matches a sibling
    // location's NAP, reclassify as sibling_match. The audited
    // storefront is still missing FROM THIS DIRECTORY (the listing
    // points at the sibling, not at us), so we ALSO add it to the
    // `missing` list with `occupied_by_sibling` populated.
    if (canonicalStatus !== 'matched' && siblings.length > 0) {
      const sibling = findMatchingSibling(
        siblings,
        probe.found_name,
        foundPhone,
        foundAddress
      );
      if (sibling) {
        citations.push({
          directory: probe.directory.id,
          url: probe.url,
          name: probe.found_name,
          address: foundAddress,
          phone: foundPhone,
          status: 'sibling_match',
        });
        missing.push({
          directory: probe.directory.id,
          priority: probe.directory.priority,
          occupied_by_sibling: {
            sibling_label: sibling.label ?? null,
            sibling_address: sibling.street_address || null,
          },
        });
        summary.push({
          directory_id: probe.directory.id,
          label: probe.directory.label,
          status: 'unverified', // surface as 'unverified' in the operator-facing summary; the structured `citations` row carries the real sibling_match status
          url: probe.url,
          error: `listing belongs to sibling location${sibling.label ? ` "${sibling.label}"` : ''}`,
        });
        continue;
      }
    }

    citations.push({
      directory: probe.directory.id,
      url: probe.url,
      name: probe.found_name,
      address: foundAddress,
      phone: foundPhone,
      status: canonicalStatus,
    });

    summary.push({
      directory_id: probe.directory.id,
      label: probe.directory.label,
      status: canonicalStatus,
      url: probe.url,
      error: null,
    });

    if (canonicalStatus === 'mismatch') {
      // For v1, flag the field generically. A future refinement
      // would inspect which sub-field (name/phone/address) drove
      // the mismatch and surface that specifically.
      inconsistencies.push({
        field: foundPhone && foundAddress ? 'address' : 'name',
        canonical: business.street_address || business.name,
        found: foundAddress || probe.found_name || '',
        citation_url: probe.url,
        directory: probe.directory.id,
      });
    }
  }

  return {
    findings: { citations, inconsistencies, missing },
    total_cost_dollars: totalCost,
    per_directory_summary: summary,
  };
}
