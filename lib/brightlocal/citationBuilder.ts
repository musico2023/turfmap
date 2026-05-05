/**
 * BrightLocal Citation Builder API wrapper.
 *
 * Sister module to lib/brightlocal/client.ts (which handles the
 * read-side Citation Tracker audit). Same auth (x-api-key), same
 * base URL — just a different product surface.
 *
 * This wrapper exposes three primitives the rest of the app needs:
 *
 *   submitCitationOrder()  — POST a business profile to BL; receive
 *                            an order id we can poll later.
 *   pollCitationOrder()    — GET per-directory status for an order.
 *   pauseMaintenance()     — tell BL to stop syncing future NAP edits
 *                            for an order (used when a Pulse+ buyer
 *                            downgrades to Pulse).
 *
 * ─── ENDPOINT PATHS — VERIFY BEFORE GOING LIVE ──────────────────────────
 *
 * The exact path components (under /data/v1/...) for the Citation
 * Builder product need to be confirmed against BrightLocal's current
 * developer docs once Anthony enables Citation Builder on the BL
 * account. The placeholder paths below mirror their published
 * convention but every consumer should treat the call sites as
 * "implementation TBD post-credentials" until smoke-tested.
 *
 * Until then: every function returns a typed { ok: false } envelope
 * with `kind: 'not_configured'` when CITATION_BUILDER_ENABLED is unset,
 * so the rest of the app can ship and fall back to manual fulfillment
 * cleanly.
 *
 * ─── Required env ──────────────────────────────────────────────────────
 *   BRIGHTLOCAL_API_KEY              — same as audit-side (already set)
 *   CITATION_BUILDER_ENABLED         — gate flag; set to 'true' once
 *                                      you've smoke-tested against
 *                                      BL's sandbox or live API
 */

import type {
  CitationDirectoryEntry,
  CitationDirectoryStatus,
  CitationSubmittedProfile,
} from '@/lib/supabase/types';

const BL_BASE = 'https://api.brightlocal.com';

/** Path components — confirm against BL docs. See header comment. */
const ENDPOINT = {
  /** POST — create a citation-build order. */
  submit: '/data/v1/citation-builder/orders',
  /** GET — fetch order status + per-directory submission state. */
  status: (orderId: string) =>
    `/data/v1/citation-builder/orders/${encodeURIComponent(orderId)}`,
  /** POST — pause ongoing sync without canceling already-live citations. */
  pause: (orderId: string) =>
    `/data/v1/citation-builder/orders/${encodeURIComponent(orderId)}/pause`,
} as const;

const HOME_DIRECTORY_SET = [
  // The default ~25 directories targeted on a citation order. BL
  // accepts a list of directory slugs and submits to each. Mirrors
  // the slug convention in lib/brightlocal/directories.ts; final
  // industry-aware selection happens at submit time via
  // chooseDirectorySet() below.
  'bing',
  'apple-maps',
  'facebook',
  'yelp',
  'yellowpages',
  'foursquare',
  'mapquest',
  'tripadvisor',
  'angi',
  'thumbtack',
  'houzz',
  'manta',
  'merchantcircle',
  'citysearch',
  'localpages',
  'cylex',
  'showmelocal',
  'hotfrog',
  'brownbook',
  'tupalo',
  'judysbook',
  'businesslistings',
  'whereto',
  'ezlocal',
  'iglobal',
] as const;

// ─── Public types ──────────────────────────────────────────────────────────

export type SubmitOrderInput = {
  /** Citation profile snapshot — what we send to BL. Must include all
   *  required NAP fields plus categories + hours + photos for BL's
   *  submission engine to fan out. */
  profile: CitationSubmittedProfile;
  /** Industry profile from lib/brightlocal/directories — drives the
   *  per-vertical directory set. */
  industry: string | null;
  /** Optional override of the default directory set. Used by the
   *  re-sync flow to target only the directories that need updating. */
  directories?: string[];
};

export type SubmitOrderResult =
  | {
      ok: true;
      orderId: string;
      directories: string[];
      wholesaleCents: number;
    }
  | {
      ok: false;
      kind:
        | 'not_configured'
        | 'invalid_profile'
        | 'rate_limited'
        | 'remote_error';
      message: string;
    };

export type PollOrderResult =
  | {
      ok: true;
      orderId: string;
      status: 'queued' | 'in_progress' | 'complete' | 'partial' | 'failed';
      perDirectory: CitationDirectoryEntry[];
      orderError: string | null;
    }
  | {
      ok: false;
      kind: 'not_configured' | 'not_found' | 'remote_error';
      message: string;
    };

export type PauseMaintenanceResult =
  | { ok: true }
  | { ok: false; kind: 'not_configured' | 'remote_error'; message: string };

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Submit a new citation-build order to BrightLocal. Idempotency is the
 * caller's responsibility — pair this call with a `citation_orders`
 * row insert in a single transaction so a retry doesn't double-submit.
 */
export async function submitCitationOrder(
  input: SubmitOrderInput
): Promise<SubmitOrderResult> {
  const config = getConfig();
  if (!config.ok) return config;

  const directories =
    input.directories ?? chooseDirectorySet(input.industry);

  // Required-field validation BEFORE round-tripping to BL — saves a
  // pointless API call when the profile is half-filled. Missing NAP
  // fields are by far the most common failure mode.
  const missing = findMissingProfileFields(input.profile);
  if (missing.length > 0) {
    return {
      ok: false,
      kind: 'invalid_profile',
      message: `missing required citation fields: ${missing.join(', ')}`,
    };
  }

  try {
    const res = await fetch(`${BL_BASE}${ENDPOINT.submit}`, {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        // Shape conforms to BL's Citation Builder submission payload.
        // Confirm field names against current BL docs — any mismatch
        // here surfaces as a 4xx with the exact missing/unexpected
        // field name in the response body.
        business_name: input.profile.business_name,
        address: input.profile.street_address,
        city: input.profile.city,
        region: input.profile.region,
        postcode: input.profile.postcode,
        country: input.profile.country_code,
        phone: input.profile.phone,
        website: input.profile.website,
        primary_category: input.profile.primary_category,
        additional_categories: input.profile.additional_categories,
        description: input.profile.description,
        hours: input.profile.hours,
        photo_urls: input.profile.photo_urls,
        directories,
      }),
    });

    if (res.status === 429) {
      return {
        ok: false,
        kind: 'rate_limited',
        message: 'BL rate limit reached — retry in 60s',
      };
    }
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        kind: 'remote_error',
        message: `BL submit ${res.status}: ${body.slice(0, 240)}`,
      };
    }

    const data = (await res.json()) as {
      order_id?: string;
      directories?: string[];
      wholesale_cents?: number;
    };
    if (!data.order_id) {
      return {
        ok: false,
        kind: 'remote_error',
        message: 'BL response missing order_id',
      };
    }
    return {
      ok: true,
      orderId: data.order_id,
      directories: data.directories ?? directories,
      // BL's pricing typically returns in their currency unit — coerce
      // to cents at the boundary. Default fallback is the rough
      // ~$2.50/dir wholesale baseline; actual values come from BL.
      wholesaleCents:
        typeof data.wholesale_cents === 'number'
          ? data.wholesale_cents
          : directories.length * 250,
    };
  } catch (e) {
    return {
      ok: false,
      kind: 'remote_error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function pollCitationOrder(
  orderId: string
): Promise<PollOrderResult> {
  const config = getConfig();
  if (!config.ok) return config;

  try {
    const res = await fetch(`${BL_BASE}${ENDPOINT.status(orderId)}`, {
      headers: { 'x-api-key': config.apiKey },
    });
    if (res.status === 404) {
      return {
        ok: false,
        kind: 'not_found',
        message: `BL order ${orderId} not found`,
      };
    }
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        kind: 'remote_error',
        message: `BL poll ${res.status}: ${body.slice(0, 240)}`,
      };
    }
    const data = (await res.json()) as {
      status?: string;
      per_directory?: Array<{
        directory?: string;
        status?: string;
        submitted_at?: string;
        live_at?: string;
        url?: string;
        message?: string;
      }>;
      error?: string;
    };

    return {
      ok: true,
      orderId,
      status: normalizeOrderStatus(data.status),
      perDirectory: (data.per_directory ?? []).map(normalizeDirectoryEntry),
      orderError: data.error ?? null,
    };
  } catch (e) {
    return {
      ok: false,
      kind: 'remote_error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function pauseMaintenance(
  orderId: string
): Promise<PauseMaintenanceResult> {
  const config = getConfig();
  if (!config.ok) return config;

  try {
    const res = await fetch(`${BL_BASE}${ENDPOINT.pause(orderId)}`, {
      method: 'POST',
      headers: { 'x-api-key': config.apiKey },
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        kind: 'remote_error',
        message: `BL pause ${res.status}: ${body.slice(0, 240)}`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      kind: 'remote_error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Industry-aware default directory set. Conservative ~25 directories
 *  for v1; overlap with HOME_DIRECTORY_SET is intentional — the
 *  universal_core (Bing/Apple/Facebook/Yelp) appears in every
 *  vertical. Final per-industry selection should pull from
 *  lib/brightlocal/directories.ts once that module exposes a
 *  citation-builder slug list (currently it's audit-side only). */
function chooseDirectorySet(_industry: string | null): string[] {
  // TODO: when lib/brightlocal/directories.ts exposes a
  // getCitationBuilderSlugsForIndustry(), call that instead. For now,
  // ship the universal home-services starter set.
  return [...HOME_DIRECTORY_SET];
}

function findMissingProfileFields(p: CitationSubmittedProfile): string[] {
  const missing: string[] = [];
  if (!p.business_name?.trim()) missing.push('business_name');
  if (!p.street_address?.trim()) missing.push('street_address');
  if (!p.city?.trim()) missing.push('city');
  if (!p.region?.trim()) missing.push('region');
  if (!p.postcode?.trim()) missing.push('postcode');
  if (!p.country_code?.trim()) missing.push('country_code');
  if (!p.phone?.trim()) missing.push('phone');
  if (!p.primary_category?.trim()) missing.push('primary_category');
  if (!p.description?.trim()) missing.push('description');
  if (!p.hours || Object.keys(p.hours).length === 0) missing.push('hours');
  return missing;
}

function normalizeOrderStatus(
  s: string | undefined
): 'queued' | 'in_progress' | 'complete' | 'partial' | 'failed' {
  switch ((s ?? '').toLowerCase()) {
    case 'queued':
    case 'pending':
      return 'queued';
    case 'in_progress':
    case 'submitting':
    case 'processing':
      return 'in_progress';
    case 'complete':
    case 'completed':
    case 'success':
      return 'complete';
    case 'partial':
    case 'partial_success':
      return 'partial';
    case 'failed':
    case 'error':
      return 'failed';
    default:
      return 'in_progress';
  }
}

function normalizeDirectoryEntry(raw: {
  directory?: string;
  status?: string;
  submitted_at?: string;
  live_at?: string;
  url?: string;
  message?: string;
}): CitationDirectoryEntry {
  const status = normalizeDirectoryStatus(raw.status);
  return {
    directory: raw.directory ?? 'unknown',
    status,
    submitted_at: raw.submitted_at ?? null,
    live_at: raw.live_at ?? null,
    url: raw.url ?? null,
    message: raw.message ?? null,
  };
}

function normalizeDirectoryStatus(
  s: string | undefined
): CitationDirectoryStatus {
  switch ((s ?? '').toLowerCase()) {
    case 'pending':
    case 'queued':
      return 'pending';
    case 'submitted':
    case 'in_progress':
      return 'submitted';
    case 'live':
    case 'success':
      return 'live';
    case 'needs_review':
    case 'manual_action_required':
    case 'verification_required':
      return 'needs_review';
    case 'failed':
    case 'rejected':
      return 'failed';
    default:
      return 'pending';
  }
}

function getConfig():
  | { ok: true; apiKey: string }
  | { ok: false; kind: 'not_configured'; message: string } {
  if (process.env.CITATION_BUILDER_ENABLED !== 'true') {
    return {
      ok: false,
      kind: 'not_configured',
      message:
        'Citation Builder is gated off. Set CITATION_BUILDER_ENABLED=true after smoke-testing the BL endpoints.',
    };
  }
  const apiKey = process.env.BRIGHTLOCAL_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      kind: 'not_configured',
      message: 'BRIGHTLOCAL_API_KEY is not set.',
    };
  }
  return { ok: true, apiKey };
}
