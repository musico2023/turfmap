/**
 * BrightLocal Listings (Citation Tracker) API wrapper.
 *
 * All BrightLocal calls in TurfMap MUST go through this module so the
 * auth, retry, and rate-limit logic stays in one place.
 *
 * Verified facts (from developer.brightlocal.com, 2026-05-02):
 *   • Live base URL: https://api.brightlocal.com
 *   • Auth: header `x-api-key: <token>`  (NOT Bearer)
 *   • Rate limits: GET 300/min, POST 100/min
 *
 * The API is per-directory + asynchronous. To audit a business across
 * many directories you fan out: one Find Profile POST per directory,
 * each returning its own `request_id`, then poll Get Results for each.
 *
 * Wire endpoints
 * ──────────────
 *   POST /data/v1/listings/find            → { request_id }
 *   POST /data/v1/listings/fetch           → { request_id }   (by known URL)
 *   GET  /data/v1/listings/results/:reqId  → { ready, success, profile, ... }
 *   GET  /data/v1/listings/directories     → { items: Directory[] }
 *
 * Pricing model
 *   - Manage plan: $37/mo (annual billing) base subscription
 *   - + per-request fees billed monthly
 *   - Trial credits during the initial trial period (1000 requests cap)
 *
 * Caller responsibility — the API route in `app/api/nap/audit/[clientId]`
 * owns the fan-out and persists per-directory request_ids so it can
 * poll completion later. This module only exposes primitives + a
 * convenience `initiateCitationAudit` that loops over a directory set.
 */
import type {
  NapAuditCitation,
  NapAuditFindings,
  NapAuditInconsistency,
  NapAuditMissing,
  NapAuditStatus,
} from '@/lib/supabase/types';

const BRIGHTLOCAL_BASE = 'https://api.brightlocal.com';

const ENDPOINT = {
  find: '/data/v1/listings/find',
  fetch: '/data/v1/listings/fetch',
  results: (requestId: string) =>
    `/data/v1/listings/results/${encodeURIComponent(requestId)}`,
  directories: '/data/v1/listings/directories',
} as const;

/**
 * Default starter directory set for US home-services audits. Each id
 * is a BrightLocal directory slug. Verified IDs in this list still
 * need to be cross-checked against `/data/v1/listings/directories`
 * once we have the trial API key wired up — slugs that 4xx will be
 * silently skipped during the fan-out.
 *
 * Keep this small in v1 (≤ ~15 directories) so each audit costs ~15
 * BL requests on initiate + 15 on poll. At 4 audits/client/month and
 * a dozen clients we stay well under both rate limits and the trial
 * credit cap.
 */
export const DEFAULT_US_DIRECTORIES: readonly string[] = [
  'google',
  'yelp',
  'facebook',
  'bbb',
  'yellowpages',
  'foursquare',
  'bing',
  'mapquest',
  'apple-maps',
  'nextdoor',
  'angi',
  'houzz',
  'thumbtack',
  'manta',
  'superpages',
] as const;

export type BusinessProfile = {
  /** Canonical business name as it should appear in citations. */
  name: string;
  /** Street address only (city/region/postcode go on their own fields). */
  street_address: string;
  /** City. */
  city: string;
  /** State/province. */
  region: string;
  /** Postal/ZIP code. */
  postcode: string;
  /** Canonical phone in E.164 if possible (e.g. +1-416-555-0100). */
  telephone: string;
  /** ISO-3166-1 alpha-3 country code (e.g. 'USA', 'GBR'). Default 'USA'. */
  country?: string;
};

export type Directory = {
  id: string;
  countries: string[];
  url: string;
};

/** One row in the per-directory request map persisted to nap_audits. */
export type AuditRequest = {
  directory: string;
  request_id: string;
};

export type AuditInitiationResult = {
  /** Map of directory → BrightLocal request_id; persisted to the audit row. */
  requests: AuditRequest[];
  /** Directories we tried but BL rejected (4xx) — surfaced for debugging. */
  rejected: { directory: string; error: string }[];
};

/** Raw shape returned by GET /listings/results/:id once `ready === true`. */
export type GetResultsResponse = {
  request_id: string;
  request_payload: {
    business_names: string[];
    country: string;
    region?: string;
    city?: string;
    postcode?: string;
    directory: string;
    telephone?: string;
    street_address?: string;
  };
  ready: boolean;
  success: boolean;
  message?: string;
  time_taken?: number;
  profile?: {
    /** Anything BL returns. Shape varies per directory; keep raw and
     *  only pluck the NAP fields we need into typed citations. */
    name?: string;
    address?: string;
    phone?: string;
    website?: string;
    url?: string;
    [key: string]: unknown;
  };
};

export type AuditStatusSummary = {
  status: NapAuditStatus;
  /** Per-directory raw results. */
  perDirectory: Array<
    GetResultsResponse & {
      directory: string;
    }
  >;
  /** True when every request_id has come back ready (success or not). */
  allReady: boolean;
};

// ─── Low-level HTTP ────────────────────────────────────────────────────────

function getApiKey(): string {
  const apiKey = process.env.BRIGHTLOCAL_API_KEY;
  if (!apiKey) {
    throw new Error(
      'BRIGHTLOCAL_API_KEY missing — set in env vars (.env.local + Vercel).'
    );
  }
  return apiKey;
}

async function brightlocalFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const url = `${BRIGHTLOCAL_BASE}${path}`;
  // Auth header verified from developer.brightlocal.com (2026-05-02):
  // `x-api-key: <token>`. Not Bearer.
  const res = await fetch(url, {
    ...init,
    headers: {
      'x-api-key': getApiKey(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `BrightLocal HTTP ${res.status} for ${path}: ${body.slice(0, 500)}`
    );
  }
  return res;
}

// ─── Primitives ────────────────────────────────────────────────────────────

/**
 * POST /data/v1/listings/find — submit a search for a business in one
 * directory. Returns the request_id you'll later poll.
 */
export async function findProfile(
  business: BusinessProfile,
  directory: string
): Promise<{ requestId: string }> {
  const res = await brightlocalFetch(ENDPOINT.find, {
    method: 'POST',
    body: JSON.stringify({
      business_names: [business.name],
      country: business.country ?? 'USA',
      region: business.region,
      city: business.city,
      postcode: business.postcode,
      directory,
      telephone: business.telephone,
      street_address: business.street_address,
    }),
  });
  const json = (await res.json()) as { request_id?: string };
  if (!json.request_id) {
    throw new Error(
      'BrightLocal Find Profile response missing request_id: ' +
        JSON.stringify(json)
    );
  }
  return { requestId: json.request_id };
}

/**
 * GET /data/v1/listings/results/:request_id — poll one request_id.
 * `ready: false` means BL is still working; `success: false` with
 * `ready: true` means the search ran but no profile was found
 * (a "missing" citation, not an error).
 */
export async function getResults(
  requestId: string
): Promise<GetResultsResponse> {
  const res = await brightlocalFetch(ENDPOINT.results(requestId));
  return (await res.json()) as GetResultsResponse;
}

/** GET /data/v1/listings/directories — enumerate all directories. */
export async function getAllDirectories(): Promise<Directory[]> {
  const res = await brightlocalFetch(ENDPOINT.directories);
  const json = (await res.json()) as { items?: Directory[] };
  return json.items ?? [];
}

// ─── High-level audit orchestration ────────────────────────────────────────

/**
 * Fan out a Find Profile across a directory set. Persists nothing —
 * the caller stores the returned `requests` array on the nap_audits row
 * so a later poll can resume.
 *
 * Network errors on individual directories are caught and reported in
 * `rejected` rather than failing the whole audit; a partial audit is
 * more useful than nothing.
 */
export async function initiateCitationAudit(
  business: BusinessProfile,
  directories: readonly string[] = DEFAULT_US_DIRECTORIES
): Promise<AuditInitiationResult> {
  const settled = await Promise.allSettled(
    directories.map(async (directory) => {
      const { requestId } = await findProfile(business, directory);
      return { directory, request_id: requestId };
    })
  );
  const requests: AuditRequest[] = [];
  const rejected: { directory: string; error: string }[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      requests.push(r.value);
    } else {
      rejected.push({
        directory: directories[i],
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });
  if (requests.length === 0) {
    throw new Error(
      `BrightLocal audit failed: 0/${directories.length} directories accepted. First error: ${rejected[0]?.error ?? 'unknown'}`
    );
  }
  return { requests, rejected };
}

/**
 * Poll the full request set. Returns aggregated status — call again
 * later if `allReady` is false.
 */
export async function pollAuditResults(
  requests: readonly AuditRequest[]
): Promise<AuditStatusSummary> {
  const settled = await Promise.allSettled(
    requests.map(async (r) => {
      const result = await getResults(r.request_id);
      return { ...result, directory: r.directory };
    })
  );
  // Treat HTTP failures as not-ready rather than fatal — the audit can
  // make progress on the directories that did respond.
  const perDirectory = settled
    .map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      return {
        request_id: requests[i].request_id,
        request_payload: {
          business_names: [],
          country: '',
          directory: requests[i].directory,
        },
        ready: false,
        success: false,
        message:
          s.reason instanceof Error ? s.reason.message : String(s.reason),
        directory: requests[i].directory,
      } satisfies GetResultsResponse & { directory: string };
    });
  const allReady = perDirectory.every((d) => d.ready);
  const status: NapAuditStatus = allReady ? 'complete' : 'running';
  return { status, perDirectory, allReady };
}

/**
 * Convert raw per-directory results into the structured findings shape
 * we persist + feed to the AI Coach. Compares each found citation's
 * NAP fields to the canonical business and tags inconsistencies.
 */
export function summarizeFindings(
  perDirectory: AuditStatusSummary['perDirectory'],
  canonical: BusinessProfile
): NapAuditFindings {
  const citations: NapAuditCitation[] = [];
  const inconsistencies: NapAuditInconsistency[] = [];
  const missing: NapAuditMissing[] = [];

  const canonicalAddress = [
    canonical.street_address,
    canonical.city,
    canonical.region,
    canonical.postcode,
  ]
    .filter(Boolean)
    .join(', ');

  for (const d of perDirectory) {
    if (!d.ready) continue;
    if (!d.success || !d.profile) {
      // BL searched and didn't find a profile in this directory.
      missing.push({
        directory: d.directory,
        // Phase 1: every missing directory is 'medium' priority. Phase 2
        // will source priority from a per-vertical lookup.
        priority: 'medium',
      });
      continue;
    }
    const found = d.profile;
    const url = (found.url as string) ?? (found.website as string) ?? '';
    const foundName = (found.name as string) ?? null;
    const foundAddress = (found.address as string) ?? null;
    const foundPhone = (found.phone as string) ?? null;

    const citationStatus = computeCitationStatus(
      { name: foundName, address: foundAddress, phone: foundPhone },
      { name: canonical.name, address: canonicalAddress, phone: canonical.telephone }
    );
    citations.push({
      directory: d.directory,
      url,
      name: foundName,
      address: foundAddress,
      phone: foundPhone,
      status: citationStatus,
    });

    if (foundName && !sameLoose(foundName, canonical.name)) {
      inconsistencies.push({
        field: 'name',
        canonical: canonical.name,
        found: foundName,
        citation_url: url,
        directory: d.directory,
      });
    }
    if (foundAddress && !sameLoose(foundAddress, canonicalAddress)) {
      inconsistencies.push({
        field: 'address',
        canonical: canonicalAddress,
        found: foundAddress,
        citation_url: url,
        directory: d.directory,
      });
    }
    if (foundPhone && !samePhone(foundPhone, canonical.telephone)) {
      inconsistencies.push({
        field: 'phone',
        canonical: canonical.telephone,
        found: foundPhone,
        citation_url: url,
        directory: d.directory,
      });
    }
  }

  return { citations, inconsistencies, missing };
}

// ─── Comparators ──────────────────────────────────────────────────────────

function normalize(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameLoose(a: string | null, b: string | null): boolean {
  return normalize(a) === normalize(b);
}

function samePhone(a: string | null, b: string | null): boolean {
  const da = (a ?? '').replace(/\D/g, '');
  const db = (b ?? '').replace(/\D/g, '');
  if (!da || !db) return false;
  // Compare last 10 digits — handles +1 vs no country code.
  return da.slice(-10) === db.slice(-10);
}

function computeCitationStatus(
  found: { name: string | null; address: string | null; phone: string | null },
  canonical: { name: string; address: string; phone: string }
): NapAuditCitation['status'] {
  const nameMatch = found.name ? sameLoose(found.name, canonical.name) : null;
  const addrMatch = found.address
    ? sameLoose(found.address, canonical.address)
    : null;
  const phoneMatch = found.phone ? samePhone(found.phone, canonical.phone) : null;
  const allKnown = [nameMatch, addrMatch, phoneMatch].filter(
    (v) => v !== null
  ) as boolean[];
  if (allKnown.length === 0) return 'unverified';
  if (allKnown.every((v) => v === true)) return 'matched';
  return 'mismatch';
}
