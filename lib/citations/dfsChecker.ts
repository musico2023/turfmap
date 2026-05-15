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
import { classifyCitation, nameMatches, type CitationStatus } from './napCompare';
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
 *  haven't filled it in, in which case we just skip phone matching. */
export type CitationBusinessProfile = {
  name: string;
  street_address: string;
  city: string;
  region: string;
  postcode: string;
  country: string;
  telephone?: string | null;
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

/** Probe one directory via a single Google SERP query. Captures any
 *  error inline — never throws to the caller. */
async function probeDirectory(
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
  const match = items.find((it) => {
    if (it.type !== 'organic') return false;
    if (!it.url) return false;
    // Compare against the directory's root domain; tolerate www. and
    // path variants. e.g., "https://www.yelp.com/biz/..." matches "yelp.com".
    const dirRoot = directory.domain.replace(/^www\./, '').split('/')[0];
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

/**
 * Run a DFS-backed citation audit against the given directory set.
 *
 * Returns NapAuditFindings shaped for storage in nap_audits.findings
 * and downstream consumption by the dashboard + AI Coach.
 *
 * Never throws — individual directory failures classify as
 * 'unverified' so a partial audit is more useful than no audit.
 */
export async function runDfsCitationAudit(
  business: CitationBusinessProfile,
  directories: readonly DfsDirectory[]
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
    const status: CitationStatus = classifyCitation(
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

    citations.push({
      directory: probe.directory.id,
      url: probe.url,
      name: probe.found_name,
      address: foundAddress,
      phone: foundPhone,
      status,
    });

    summary.push({
      directory_id: probe.directory.id,
      label: probe.directory.label,
      status,
      url: probe.url,
      error: null,
    });

    if (status === 'mismatch') {
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
