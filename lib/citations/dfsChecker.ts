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
import { expandRegion } from '@/lib/geo/regionNames';

const DFS_BASE_URL = 'https://api.dataforseo.com';
const DFS_LIVE_ADVANCED = '/v3/serp/google/organic/live/advanced';

/** Max concurrent DFS requests during a citation audit. 12 directories
 *  at concurrency 6 = 2 batches sequentially = ~3-5s total. */
const CITATION_CONCURRENCY = 6;

/** Per-call DFS retry — kept in step with lib/dataforseo/client.ts.
 *
 *  40207 = IP-not-whitelisted blip on dual-stack networks.
 *  40101 = "Internal SE Server Error", a DFS capacity dip. This was missing
 *  here even after the grid client learned it, so a transient 40101 on the
 *  google_business probe was reported to a client as "no Google Business
 *  Profile — high priority" (Five Star Painting of Austin, 2026-09-16; a
 *  470-review listing). Four attempts with exponential jittered backoff is
 *  what cleared 40101 on the grid scanner. */
const DFS_RETRYABLE_TASK_CODES = new Set<number>([40207, 40101]);
const DFS_MAX_ATTEMPTS = 4;

/** 500ms → 1s → 2s, jittered so concurrent probes don't retry in lockstep. */
function retryDelayMs(attempt: number): number {
  return 500 * Math.pow(2, attempt - 1) + Math.random() * 300;
}

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
  /** Google place_id for the audited location, set ONLY when TurfMap has
   *  already linked and verified the listing (see locationToCitationProfile).
   *  When present the google_business directory is classified from it
   *  directly instead of being probed — we already know the GBP exists, and
   *  a flaky local_pack probe was reporting verified 470-review profiles as
   *  missing. */
  google_place_id?: string | null;
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
  /** Diagnostic snapshot of what DFS returned (site_serp probe only).
   *  Lets a "missing" be diagnosed without guessing: total_items=0 → DFS
   *  returned nothing; on_domain=[] with total_items>0 → the directory's
   *  profile wasn't in DFS's site: results (recall); on_domain populated →
   *  the profile WAS returned but rejected by the URL/name filters
   *  (matching). Persisted into per_directory_summary for missing rows. */
  debug?: {
    total_items: number;
    on_domain: Array<{ type?: string; url?: string; title?: string }>;
  } | null;
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
  // NO exact-phrase quotes around the name. A quoted "{full name}" misses
  // real listings whose indexed title is a variant — "&" vs "and", a
  // shortened form, or a dropped location qualifier — confirmed as
  // false-negatives on CertaPro's real Facebook + BBB profiles (the
  // quoted query surfaced BBB category pages, not the profile). Recall
  // comes from the unquoted terms; precision is restored by the
  // nameMatches gate on the selected result (see probeDirectoryViaSiteSerp).
  return `site:${directory.domain} ${business.name} ${business.city}`;
}

/** Map BusinessProfile.country to a DFS location_name string. DFS uses
 *  a "City,Region,Country" format with the country name spelled out, and
 *  the region spelled out too — 2-letter codes are expanded via
 *  expandRegion (lib/geo/regionNames; full names pass through unchanged).
 *  DFS's location database returns zero results for an unrecognized
 *  location ("Calgary,AB,Canada"), so the expansion is load-bearing for
 *  the ~half of clients carrying Google-Places 2-letter region codes.
 *  Exported for the geo guard (scripts/verify-dfs-citation-geo.ts). */
export function dfsLocationFromBusiness(business: CitationBusinessProfile): string {
  // ISO-3 country code → DFS expected name.
  const countryMap: Record<string, string> = {
    USA: 'United States',
    CAN: 'Canada',
    GBR: 'United Kingdom',
    AUS: 'Australia',
  };
  const countryName = countryMap[business.country] ?? 'United States';
  const region = expandRegion(business.region);
  return `${business.city},${region},${countryName}`;
}

/** Apply DFS geo-targeting to a SERP task body. Coord-first: when the
 *  business has lat/lng we pass `location_coordinate` (the robust path the
 *  GBP local_pack probe already used) and skip location_name entirely.
 *  This is what fixes the 2-letter-region bug — a coordinate can't be
 *  malformed the way "Calgary,AB,Canada" was. Only when coords are absent
 *  do we fall back to the (now region-expanded) location_name string.
 *  Exported for the geo guard (scripts/verify-dfs-citation-geo.ts). */
export function applyDfsGeo(
  body: Record<string, unknown>,
  business: CitationBusinessProfile
): void {
  if (
    typeof business.latitude === 'number' &&
    typeof business.longitude === 'number'
  ) {
    // "lat,lng,radius_km" — same shape lib/dataforseo/client.ts uses.
    body.location_coordinate = `${business.latitude},${business.longitude},1`;
  } else {
    body.location_name = dfsLocationFromBusiness(business);
  }
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
  const body: Record<string, unknown> = {
    keyword: buildSerpQuery(business, directory),
    language_code: 'en',
    device: 'desktop',
    // Cap depth at 10 results — citation listings rank well above
    // that floor on direct site: filters; no value in fetching 100.
    depth: 10,
    tag: `citation:${directory.id}`,
  };
  // Coord-first geo (see applyDfsGeo). A location_name built from a
  // 2-letter region code ("Calgary,AB,Canada") is an invalid DFS location
  // and returned zero results — which made EVERY site_serp probe falsely
  // report "missing" for ~half the book (Google-Places-enriched clients).
  applyDfsGeo(body, business);

  let task: DfsTask | null = null;
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= DFS_MAX_ATTEMPTS; attempt++) {
    try {
      task = await postSerpTask(body);
      if (task.status_code === 20000) break;
      if (!DFS_RETRYABLE_TASK_CODES.has(task.status_code)) break;
      if (attempt < DFS_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
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
      // A thrown request is always an error. A completed task that reports
      // "no results" (40102) is a real absent answer, so error stays null.
      error: task ? dfsTaskError(task.status_code, task.status_message) : (lastError ?? 'DFS request failed'),
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
  const SEARCH_URL_PATTERNS = /\/(search|find|finder|browse|sitemap|category)|[?&](q|query|find_desc|find_near|find_loc|location|search)=/i;
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
    // Reject directory-search / category / index-page URLs.
    if (SEARCH_URL_PATTERNS.test(it.url)) return false;
    // Require the title to actually match the business. Without quotes the
    // SERP can rank a directory's category/index page or the brand's
    // corporate / other-location profile above the real listing; those
    // titles fail nameMatches, so we skip them and select the real one.
    // (Confirmed: this picks CertaPro's Calgary FB/BBB profile over the
    // corporate "CertaPro Painters" page and BBB category pages.)
    if (!nameMatches(business.name, it.title ?? null)) return false;
    return true;
  });

  // Diagnostic snapshot — only assembled when there's no match (the case we
  // need to debug). Captures every on-domain result DFS returned so a
  // "missing" can be classified as recall (profile not returned) vs
  // matching (returned but filtered out).
  const debug = match
    ? null
    : {
        total_items: items.length,
        on_domain: items
          .filter((it) => it.url && it.url.toLowerCase().includes(dirRoot))
          .slice(0, 6)
          .map((it) => ({
            type: it.type,
            url: it.url,
            title: it.title?.slice(0, 120),
          })),
      };

  return {
    directory,
    url: match?.url ?? null,
    found_name: match?.title ?? null,
    found_snippet: match?.description ?? null,
    cost_dollars: task.cost ?? 0,
    error: null,
    debug,
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
  const body: Record<string, unknown> = {
    keyword: `${business.name} ${business.city}`,
    language_code: 'en',
    device: 'desktop',
    depth: 10,
    tag: `citation:${directory.id}`,
  };
  // Coord-first geo (lat/lng → location_coordinate), region-expanded
  // location_name fallback. Shared with the site_serp probe.
  applyDfsGeo(body, business);

  let task: DfsTask | null = null;
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= DFS_MAX_ATTEMPTS; attempt++) {
    try {
      task = await postSerpTask(body);
      if (task.status_code === 20000) break;
      if (!DFS_RETRYABLE_TASK_CODES.has(task.status_code)) break;
      if (attempt < DFS_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
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
      // A thrown request is always an error. A completed task that reports
      // "no results" (40102) is a real absent answer, so error stays null.
      error: task ? dfsTaskError(task.status_code, task.status_message) : (lastError ?? 'DFS request failed'),
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

/** Street-type words that terminate a US/CA street address. Requiring one
 *  is what separates "500 N Capital of Texas Hwy" from snippet noise. */
const STREET_SUFFIXES = [
  'St', 'Street', 'Ave', 'Av', 'Avenue', 'Rd', 'Road', 'Blvd', 'Boulevard',
  'Dr', 'Drive', 'Ln', 'Lane', 'Hwy', 'Highway', 'Pkwy', 'Parkway', 'Pky',
  'Way', 'Ct', 'Court', 'Pl', 'Place', 'Cir', 'Circle', 'Ter', 'Terrace',
  'Trl', 'Trail', 'Sq', 'Square', 'Loop', 'Pike', 'Fwy', 'Freeway', 'Expy',
  'Expressway', 'Cres', 'Crescent', 'Plz', 'Plaza', 'Xing', 'Crossing',
  'Tpke', 'Turnpike', 'Cswy', 'Causeway', 'Aly', 'Alley',
];
const DIRECTIONALS = 'N|S|E|W|NE|NW|SE|SW|North|South|East|West|Northeast|Northwest|Southeast|Southwest';

/** Words that follow a number in snippets but are never a street name —
 *  counts, times and durations. Checked against the first word after the
 *  number, so "248 Photos", "470 Reviews" and "8:00 AM" are rejected even if
 *  a suffix-shaped word appears later in the fragment. */
const NON_STREET_WORDS = new Set([
  'am', 'pm', 'photos', 'photo', 'reviews', 'review', 'ratings', 'rating',
  'stars', 'star', 'years', 'year', 'yrs', 'months', 'days', 'hours', 'hrs',
  'minutes', 'mins', 'customers', 'clients', 'jobs', 'projects', 'homes',
  'people', 'employees', 'locations', 'times', 'percent', 'followers',
  'likes', 'check', 'checkins', 'visits', 'votes',
]);

const ADDRESS_RE = new RegExp(
  String.raw`\b(\d{1,6}[A-Za-z]?(?:-\d{1,6})?)\s+` +
    String.raw`((?:(?:${DIRECTIONALS})\.?\s+)?` +
    // Up to five name words, lowercase connectors allowed ("Capital of Texas").
    // Separators like "·", "|", "•" and commas are excluded, so a match can't
    // span two snippet fields.
    String.raw`(?:[A-Za-z0-9][A-Za-z0-9'&.-]*\s+){0,5}?` +
    String.raw`(?:${STREET_SUFFIXES.join('|')})\b\.?` +
    String.raw`(?:\s+(?:${DIRECTIONALS})\b\.?)?)`,
  'gi'
);

/** Pull a street address out of a free-text snippet, or null.
 *
 *  The previous heuristic was "a number followed by a capitalised word",
 *  which read business hours and counters as addresses — "8:00 AM" became
 *  the address "00 AM" and "248 Photos" became Yelp's address, and the
 *  former was then reported to a client as a NAP mismatch to fix. It also
 *  truncated real addresses at the first lowercase word ("500 N Capital").
 *
 *  Now a match must end in a street-type suffix, and the word after the
 *  number must not be a count/time noun. Returning null is always safe:
 *  classifyCitation treats a missing address as unverified, never mismatch. */
export function extractAddressFromSnippet(snippet: string | null): string | null {
  if (!snippet) return null;
  ADDRESS_RE.lastIndex = 0;
  for (const m of snippet.matchAll(ADDRESS_RE)) {
    const rest = m[2] ?? '';
    const firstWord = rest
      .replace(new RegExp(String.raw`^(?:${DIRECTIONALS})\.?\s+`, 'i'), '')
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/[^a-z]/g, '');
    if (firstWord && NON_STREET_WORDS.has(firstWord)) continue;
    let fragment = `${m[1]} ${rest}`.trim();
    // "143 4999 43 St SE": a stray number (unit, count) directly before the
    // real house number gets absorbed as a name word. When the second token
    // is itself a 3+ digit number, it is the house number. A 1–2 digit second
    // token is a numbered street ("908 53 Avenue") and is left alone.
    fragment = fragment.replace(/^\d{1,6}\s+(?=\d{3,6}\s)/, '');
    return fragment;
  }
  return null;
}

/** DFS "No Search Results". An ANSWER, not a failure: the search ran and the
 *  directory has no listing. Must map to absent — treating it as an error
 *  both hid genuinely missing listings and counted them toward the audit's
 *  integrity gate, which would fail whole audits for thin-footprint
 *  businesses (found live on Bing Places, 2026-09-16). */
export const DFS_NO_RESULTS_CODE = 40102;

/** Error text for a non-successful DFS task, or null when the task outcome is
 *  a real answer (success, or no results). */
export function dfsTaskError(
  statusCode: number | undefined,
  statusMessage: string | undefined
): string | null {
  if (statusCode === 20000 || statusCode === DFS_NO_RESULTS_CODE) return null;
  return `DFS task ${statusCode}: ${statusMessage ?? 'unknown'}`;
}

/** What a single probe tells us. `errored` is kept distinct from `absent`:
 *  a DFS failure means we don't know, and must never be reported to a client
 *  as "you have no listing here". */
export function probeOutcome(probe: {
  error: string | null;
  url: string | null;
}): 'errored' | 'absent' | 'found' {
  if (probe.error) return 'errored';
  if (!probe.url) return 'absent';
  return 'found';
}

/** Should an absent result get one more probe before being reported missing?
 *  Only for high-priority directories: those gaps lead the AI Coach's Fix
 *  List, and Google's site: results are not deterministic — the identical
 *  query returned Five Star Painting of Austin's BBB profile on one run and
 *  left it out of the top 10 on the next (2026-09-16/17). */
export function shouldRetryAbsent(probe: {
  error: string | null;
  url: string | null;
  directory: { priority: string };
}): boolean {
  return probeOutcome(probe) === 'absent' && probe.directory.priority === 'high';
}

/** Combine a first probe with its recall retry. The retry only replaces the
 *  original when it found the listing; a retry that errors or is also absent
 *  keeps the original absent answer (an error on a second look must not
 *  downgrade a real answer to "unknown"). Cost is always summed. */
export function mergeRecallRetry<T extends { error: string | null; url: string | null; cost_dollars: number }>(
  original: T,
  retry: T
): T {
  const cost_dollars = original.cost_dollars + retry.cost_dollars;
  return probeOutcome(retry) === 'found'
    ? { ...retry, cost_dollars }
    : { ...original, cost_dollars };
}

/** Which field actually drove a mismatch, with the matching canonical and
 *  found values. Replaces `foundPhone && foundAddress ? 'address' : 'name'`,
 *  which labelled any mismatch lacking a phone as a NAME mismatch while
 *  putting the canonical ADDRESS beside it ("name: '00 AM' vs '500 North
 *  Capital of Texas Highway'"). */
export function describeMismatch(
  canonical: { name: string; phone: string | null | undefined; address: string | null | undefined },
  found: { name: string | null; phone: string | null; address: string | null }
): { field: 'name' | 'address' | 'phone'; canonical: string; found: string } {
  if (canonical.address && found.address && !addressMatches(canonical.address, found.address)) {
    return { field: 'address', canonical: canonical.address, found: found.address };
  }
  if (canonical.phone && found.phone && !phoneMatches(canonical.phone, found.phone)) {
    return { field: 'phone', canonical: canonical.phone, found: found.phone };
  }
  return { field: 'name', canonical: canonical.name, found: found.name ?? '' };
}

/** The google_business citation for a location whose GBP TurfMap has already
 *  linked and verified, or null when there's no verified place_id and the
 *  directory must be probed as before. */
export function verifiedGbpCitation(business: CitationBusinessProfile): NapAuditCitation | null {
  if (!business.google_place_id) return null;
  return {
    directory: 'google_business',
    url: `https://www.google.com/maps/place/?q=place_id:${business.google_place_id}`,
    name: business.name,
    address: business.street_address || null,
    phone: business.telephone ?? null,
    status: 'matched',
  };
}

/** Aggregate cost + per-directory probe summary returned alongside the
 *  findings. Used by autoAudit.ts to stamp the nap_audits row with
 *  provider-specific cost info. */
export type DfsCitationAuditResult = {
  findings: NapAuditFindings;
  total_cost_dollars: number;
  /** Directory ids whose probe errored after retries. They appear in neither
   *  `citations` nor `missing` — we don't know their state. The caller uses
   *  the count as an integrity gate (see runDfsAudit in autoAudit.ts). */
  errored_directories: string[];
  /** How many directories were actually probed (excludes a google_business
   *  resolved from a verified place_id). Denominator for that gate. */
  probed_count: number;
  per_directory_summary: Array<{
    directory_id: string;
    label: string;
    status: 'matched' | 'mismatch' | 'unverified' | 'missing';
    url: string | null;
    error: string | null;
    /** Site_serp diagnostic for missing rows (see DirectoryProbeResult.debug). */
    debug?: {
      total_items: number;
      on_domain: Array<{ type?: string; url?: string; title?: string }>;
    } | null;
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
 * Authoritative-NAP override for the Google Business Profile directory.
 *
 * Signal provenance + caveats (incl. why NAP "missing" is not "absent"):
 * lib/google/gbpSignalProvenance.ts.
 *
 * Why: the canonical NAP this audit compares against was itself stamped
 * from Google Place Details, so for `google_business` the listing's NAP
 * IS the canonical NAP — you can't be "inconsistent with Google" on
 * Google's own listing. The probe for this directory is `local_pack`,
 * which confirms the GBP exists (name + cid match) but does NOT expose
 * phone/address on local_pack items, so the snippet extractors return
 * null. Left as-is, a present, well-ranked GBP gets falsely classified
 * `unverified` with no phone/address (the AI Coach then renders that as
 * "the GBP is unverified with no phone or address on record" — a false,
 * client-facing claim). For google_business, substitute the
 * authoritative NAP so classification reflects reality.
 *
 * Found 2026-06-18 (Payless Kitchen Cabinets: real GBP w/ 650 reviews +
 * phone + address surfaced as "unverified, no NAP").
 *
 * Returns the [phone, address] tuple to classify with. No-op for every
 * other directory — only the google_business listing is authoritatively
 * ours; third-party directories must still be probed for real.
 */
export function resolveFoundNapForDirectory(
  directoryId: string,
  business: Pick<CitationBusinessProfile, 'telephone' | 'street_address'>,
  extractedPhone: string | null,
  extractedAddress: string | null
): [string | null, string | null] {
  if (directoryId === 'google_business') {
    return [
      business.telephone ?? extractedPhone,
      business.street_address || extractedAddress,
    ];
  }
  return [extractedPhone, extractedAddress];
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
 * Never throws. A directory whose probe errors is reported in
 * `errored_directories` and omitted from both `citations` and `missing` —
 * an outage is "unknown", not "you have no listing". (It used to classify
 * as missing, which turned DFS 40101 blips into high-priority "claim your
 * Google Business Profile" advice for businesses that already had one.)
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
      errored_directories: [],
      probed_count: 0,
      per_directory_summary: [],
    };
  }

  const gbpCitation = verifiedGbpCitation(business);
  const toProbe = gbpCitation
    ? directories.filter((d) => d.id !== 'google_business')
    : Array.from(directories);

  const probes = await mapWithConcurrency(
    toProbe,
    CITATION_CONCURRENCY,
    (d) => probeDirectory(business, d)
  );

  // One recall retry for high-priority directories that came back absent
  // (see shouldRetryAbsent). Bounded: at most one extra call per such
  // directory, and only when the first answer was "not there".
  const retryIdx = probes
    .map((p, idx) => (shouldRetryAbsent(p) ? idx : -1))
    .filter((idx) => idx >= 0);
  if (retryIdx.length > 0) {
    const retries = await mapWithConcurrency(retryIdx, CITATION_CONCURRENCY, (idx) =>
      probeDirectory(business, probes[idx].directory)
    );
    retryIdx.forEach((idx, k) => {
      probes[idx] = mergeRecallRetry(probes[idx], retries[k]);
    });
  }

  const citations: NapAuditCitation[] = [];
  const inconsistencies: NapAuditInconsistency[] = [];
  const missing: NapAuditMissing[] = [];
  const summary: DfsCitationAuditResult['per_directory_summary'] = [];
  const erroredDirectories: string[] = [];
  let totalCost = 0;

  if (gbpCitation && directories.some((d) => d.id === 'google_business')) {
    citations.push(gbpCitation);
    summary.push({
      directory_id: 'google_business',
      label: 'Google Business Profile',
      status: 'matched',
      url: gbpCitation.url,
      error: null,
    });
  }

  for (const probe of probes) {
    totalCost += probe.cost_dollars;

    const outcome = probeOutcome(probe);
    if (outcome === 'errored') {
      // Unknown, not absent. Surface it to the operator in the summary, but
      // keep it out of `missing` so the AI Coach never tells a client to
      // claim a listing we simply failed to check.
      erroredDirectories.push(probe.directory.id);
      summary.push({
        directory_id: probe.directory.id,
        label: probe.directory.label,
        status: 'unverified',
        url: null,
        error: probe.error,
        debug: probe.debug ?? null,
      });
      continue;
    }
    if (outcome === 'absent') {
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
        debug: probe.debug ?? null,
      });
      continue;
    }

    // outcome === 'found' guarantees a url; restated so the compiler narrows
    // probe.url to string for the pushes below.
    if (!probe.url) continue;

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
        debug: probe.debug ?? null,
      });
      continue;
    }

    // Name matched — extract NAP fragments and classify.
    let foundPhone = extractPhoneFromSnippet(probe.found_snippet);
    let foundAddress = extractAddressFromSnippet(probe.found_snippet);
    // Authoritative-source override: google_business uses our Google
    // Place Details NAP (the local_pack probe can't see phone/address),
    // so a present GBP isn't falsely flagged 'unverified' with no NAP.
    [foundPhone, foundAddress] = resolveFoundNapForDirectory(
      probe.directory.id,
      business,
      foundPhone,
      foundAddress
    );
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
      const detail = describeMismatch(
        { name: business.name, phone: business.telephone ?? null, address: business.street_address },
        { name: probe.found_name, phone: foundPhone, address: foundAddress }
      );
      inconsistencies.push({
        ...detail,
        citation_url: probe.url,
        directory: probe.directory.id,
      });
    }
  }

  return {
    findings: { citations, inconsistencies, missing },
    total_cost_dollars: totalCost,
    errored_directories: erroredDirectories,
    probed_count: toProbe.length,
    per_directory_summary: summary,
  };
}
