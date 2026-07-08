/**
 * BrightLocal Citation Builder API wrapper.
 *
 * Sister module to lib/brightlocal/client.ts (audit-side Citation
 * Tracker). NOTE: these are TWO DIFFERENT BL APIs running on
 * DIFFERENT hosts with DIFFERENT auth models. Don't conflate them.
 *
 *   audit-side (lib/brightlocal/client.ts):
 *     host: api.brightlocal.com
 *     auth: x-api-key header
 *     body: JSON
 *
 *   citation-builder (this file):
 *     host: tools.brightlocal.com/seo-tools/api
 *     auth: api-key + expires query params
 *           (sig+HMAC-SHA1 historically required; deprecated as of
 *           the latest BrightLocal/apiclient-php release — api-key
 *           alone is sufficient now)
 *     body: form-encoded (application/x-www-form-urlencoded);
 *           image upload uses multipart/form-data
 *
 * Endpoints (current — Management APIs v1, May 2026):
 *   POST  /manage/v1/citation-builder              — create campaign
 *                                                    from a location id;
 *                                                    returns campaign_id
 *   POST  /v2/cb/upload/{campaignId}/image         — upload one photo
 *                                                    (multipart; still
 *                                                    on /v2 path)
 *   PUT   /manage/v1/citation-builder/
 *           {campaignId}/confirm                   — confirm + pay
 *                                                    (replaces deprecated
 *                                                    POST /v2/cb/confirm-and-pay
 *                                                    which silently 4xx'd
 *                                                    after May 10 migration)
 *   GET   /manage/v1/citation-builder/{campaignId} — campaign metadata,
 *                                                    status, per-citation
 *                                                    submission state
 *                                                    (single endpoint —
 *                                                    no more /v4/cb/get +
 *                                                    /v2/cb/citations dance)
 *
 * Pause: BL doesn't expose a documented "pause syncing" endpoint in
 * the public examples. We mark maintenance_paused locally and stop
 * polling; operator pauses sync on the BL dashboard if needed.
 *
 * Required env:
 *   BRIGHTLOCAL_API_KEY                — same key as audit-side
 *                                        (Citation Builder must be
 *                                        enabled on the BL plan)
 *   CITATION_BUILDER_ENABLED           — 'true' to actually fire
 *                                        requests; otherwise every
 *                                        function returns
 *                                        { ok: false, kind:
 *                                          'not_configured' }
 *   BRIGHTLOCAL_CB_PACKAGE_ID          — optional, defaults to
 *                                        'cb15'. The BL package SKU
 *                                        the campaign should be
 *                                        billed under.
 */

import type {
  CitationDirectoryEntry,
  CitationDirectoryStatus,
  CitationOrderStatus,
  CitationSubmittedProfile,
} from '@/lib/supabase/types';

const BL_BASE = 'https://tools.brightlocal.com/seo-tools/api';

/** BL category id used as a generic fallback. The category-id field
 *  is required by BL's create-campaign endpoint but is a numeric BL
 *  internal id distinct from the GBP category strings we collect.
 *  605 is "Restaurant" in BL's example; in practice BL assigns
 *  citations based on the `business_categories` JSON list anyway, so
 *  a fallback id is acceptable for v1. Replace with a per-vertical
 *  lookup once the BL BusinessCategories endpoint is wired up. */
const FALLBACK_CATEGORY_ID = 605;

/** Default Citation Builder package SKU. Override via env
 *  (`BRIGHTLOCAL_CB_PACKAGE_ID`).
 *
 *  Calibration (2026-05-17): the homepage Pulse+ tier claims "Initial
 *  citation building across ~25 industry directories". The previous
 *  default `cb15` (15 manual citations) under-shot that claim by
 *  ~10 directories. BL's `Add Campaign` dashboard pre-selects more
 *  citations than the package SKU requests when location metadata
 *  is rich (we saw 35 pre-selected for Sugar Daddy Doughnuts), but
 *  the SKU we send still determines the BASE price.
 *
 *  Switching to `cb25` matches the marketed promise on the homepage:
 *  25 direct manual submissions + 3 aggregator pushes that propagate
 *  to ~30 downstream destinations = the "~25 directories" envelope.
 *  Unit economics at this SKU + aggregators stay healthy for the
 *  $99/mo Pulse+ monthly tier (~45% margin at 3-month commitment).
 *
 *  Operators can still customize per-campaign in the BL dashboard
 *  before "Continue to Payment" — deselect aggregators or trim
 *  manual count when a specific buyer's vertical doesn't warrant
 *  the full set. */
const DEFAULT_PACKAGE_ID = 'cb25';

// In-request confirm retry budget. BL's async citation lookup often
// finishes within ~30s of create; we retry the confirm on 'not_ready' for
// ~28s (well inside the route's 60s maxDuration). Slower lookups fall
// through to 'awaiting_confirm' and are finalized by the poll cron.
const CONFIRM_MAX_ATTEMPTS = 5;
const CONFIRM_RETRY_MS = 7000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Public types ──────────────────────────────────────────────────────────

export type SubmitOrderInput = {
  /** Citation profile snapshot — what we send to BL. Must include all
   *  required NAP fields plus categories + hours + photos for BL's
   *  submission engine to fan out. */
  profile: CitationSubmittedProfile;
  /** Industry profile (informational; carried for future per-vertical
   *  category-id lookup). */
  industry: string | null;
  /** Operator/buyer contact info. BL requires contact name + email on
   *  every campaign. We derive these from the agency user submitting
   *  the order. */
  contact: {
    firstname: string;
    lastname: string;
    email: string;
  };
  /** Stable cross-system reference for the underlying location, used
   *  as BL's `location-reference` so subsequent submits for the same
   *  storefront can find the existing BL location instead of creating
   *  a duplicate. We pass our turfmap client_locations.id (UUID). */
  locationReference: string;
  /** Optional override of BL's default directory selection. When unset
   *  we let BL autoselect from the package. */
  directories?: string[];
};

export type SubmitOrderResult =
  | {
      // ok:true means the BL campaign was CREATED (so it must be persisted,
      // even when not yet confirmed) — confirmState says how far it got.
      ok: true;
      /** BL's campaign id, persisted to citation_orders.brightlocal_order_id. */
      orderId: string;
      /** The list of directories BL will submit to (when autoselect
       *  the list is unknown until poll, so we return [] in that
       *  case). */
      directories: string[];
      wholesaleCents: number;
      /** Outcome of the confirm/pay step:
       *   - 'confirmed'        → paid + queued (persist status 'queued')
       *   - 'awaiting_confirm' → BL's async citation lookup isn't done yet;
       *                          the poll cron finalizes it (status
       *                          'awaiting_confirm')
       *   - 'confirm_failed'   → a real confirm error (persist 'failed',
       *                          surface confirmMessage) */
      confirmState: 'confirmed' | 'awaiting_confirm' | 'confirm_failed';
      /** Error/context message when confirmState !== 'confirmed'. */
      confirmMessage?: string;
    }
  | {
      // ok:false means NO campaign was created (nothing to persist).
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
      status: CitationOrderStatus;
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
 * Submit a new citation-build campaign to BrightLocal. Three-step:
 *   1. POST /manage/v1/citation-builder                  → campaign_id
 *   2. for each photo URL → POST /v2/cb/upload/{id}/image (best-effort)
 *   3. PUT  /manage/v1/citation-builder/{id}/confirm     → confirms + pays
 *                                                          (queues submissions)
 *
 * Idempotency is the caller's responsibility — pair with a
 * citation_orders insert in the same transaction so a retry doesn't
 * re-create + re-pay.
 */
export async function submitCitationOrder(
  input: SubmitOrderInput
): Promise<SubmitOrderResult> {
  const config = getConfig();
  if (!config.ok) return config;

  const missing = findMissingProfileFields(input.profile);
  if (missing.length > 0) {
    return {
      ok: false,
      kind: 'invalid_profile',
      message: `missing required citation fields: ${missing.join(', ')}`,
    };
  }

  // Step 0 — ensure a BL "location" object exists for this storefront.
  // BL Citation Builder campaigns reference a numeric BL-account-
  // internal location_id, NOT our turfmap location UUID. We use our
  // UUID as BL's `location-reference` for idempotency: re-submitting
  // for the same storefront finds the existing BL location instead
  // of creating a duplicate.
  const locationRes = await ensureBlLocation(config.apiKey, input);
  if (!locationRes.ok) return locationRes.error;
  const blLocationId = locationRes.locationId;

  // Step 1 — create campaign on BL's NEW Management APIs surface:
  //   POST https://api.brightlocal.com/manage/v1/citation-builder
  //   Header  x-api-key: <key>
  //   Header  Content-Type: application/json
  //   Body    { "location_id": <number> }
  //   Resp    201 { "campaign_id": <number> }
  //
  // Per the official Stoplight docs at
  // developer.brightlocal.com/docs/management-apis/c069xg926oruf-create-campaign,
  // the (deprecated) PHP-helper-repo `/v4/cb/create` endpoint that we
  // were targeting before is gone. The new endpoint takes ONLY
  // location_id (+ optional email_alerts) — campaign metadata
  // (categories, hours, photos, descriptions) all live ON THE
  // LOCATION object created in step 0, not on the campaign.
  const createRes = await createCampaignManageV1(
    config.apiKey,
    blLocationId
  );
  if (!createRes.ok) {
    return {
      ok: false,
      kind: createRes.error.kind,
      message: `${createRes.error.message} [blLocationId="${blLocationId}", source=${locationRes.source}]`,
    };
  }
  const campaignId = createRes.campaignId;

  // Step 2 — upload photos. Best-effort; a photo failing isn't a
  // showstopper for the submission. Operator can re-upload later via
  // BL dashboard if needed.
  const photoUrls = input.profile.photo_urls ?? [];
  for (const url of photoUrls) {
    try {
      const bytes = await fetchPhotoBytes(url);
      if (!bytes) continue;
      await uploadCampaignImage(
        config.apiKey,
        campaignId,
        bytes.contentType,
        bytes.filename,
        bytes.data
      );
    } catch {
      // Swallow. BL accepts the campaign without photos; logging here
      // would noise prod without giving the operator anything
      // actionable they can't already see by checking the campaign
      // on the BL dashboard.
    }
  }

  // Step 3 — confirm and pay. This is the moment BL is actually
  // billed (against the account's credit balance). Pre-step gating
  // by tier already happened in the calling route (Pulse+ only).
  //
  // Uses the NEW Management API path
  //   PUT /manage/v1/citation-builder/{campaign_id}/confirm
  // (was POST /v2/cb/confirm-and-pay before the May 10 migration; the
  // old endpoint was silently 4xx'ing, leaving campaigns in "Saved"
  // state and never queuing submissions — see confirmCampaignManageV1
  // header for the full incident note).
  // Retry the confirm on BL's 'not_ready' (async citation lookup still
  // running). Any other error, or exhausting the retries, maps to a
  // confirmState the caller persists — the campaign was created either way,
  // so it must never be dropped/orphaned.
  let confirmState: 'confirmed' | 'awaiting_confirm' | 'confirm_failed' =
    'awaiting_confirm';
  let confirmMessage: string | undefined;
  for (let attempt = 1; attempt <= CONFIRM_MAX_ATTEMPTS; attempt++) {
    const confirm = await confirmCampaignManageV1(config.apiKey, campaignId, {
      packageId: config.packageId,
      countryCode3: input.profile.country_code ?? 'USA',
      directories: input.directories,
      notes: null,
    });
    if (confirm.ok) {
      confirmState = 'confirmed';
      confirmMessage = undefined;
      break;
    }
    if (confirm.error.kind === 'not_ready') {
      confirmState = 'awaiting_confirm';
      confirmMessage = confirm.error.message;
      if (attempt < CONFIRM_MAX_ATTEMPTS) {
        await sleep(CONFIRM_RETRY_MS);
        continue;
      }
      break; // lookup still running after the in-request budget → defer
    }
    // A real confirm error (remote_error / rate_limited): stop retrying.
    confirmState = 'confirm_failed';
    confirmMessage = confirm.error.message;
    break;
  }

  // BL doesn't return a wholesale price on confirm-and-pay — it bills
  // per package. Stamp a placeholder; the dashboard's cost rollup
  // already keys off citation_orders.wholesale_cents so a future
  // backfill can reconcile against BL invoicing.
  return {
    ok: true,
    orderId: campaignId,
    directories: input.directories ?? [],
    wholesaleCents: estimatePackageCostCents(config.packageId),
    confirmState,
    confirmMessage,
  };
}

/**
 * Confirm/pay an already-created BL campaign. Used by the poll cron to
 * finalize 'awaiting_confirm' orders once BL's citation lookup completes.
 * Returns notReady=true when the lookup is still running (caller leaves the
 * order awaiting_confirm and retries next tick).
 */
export async function confirmCitationOrder(
  campaignId: string,
  args: { countryCode3: string; directories?: string[] | null }
): Promise<
  | { ok: true }
  | { ok: false; notReady: boolean; message: string }
> {
  const config = getConfig();
  if (!config.ok) return { ok: false, notReady: false, message: config.message };
  const confirm = await confirmCampaignManageV1(config.apiKey, campaignId, {
    packageId: config.packageId,
    countryCode3: args.countryCode3,
    directories: args.directories ?? null,
    notes: null,
  });
  if (confirm.ok) return { ok: true };
  return {
    ok: false,
    notReady: confirm.error.kind === 'not_ready',
    message: confirm.error.message,
  };
}

export async function pollCitationOrder(
  orderId: string
): Promise<PollOrderResult> {
  const config = getConfig();
  if (!config.ok) return config;

  // BL's Management APIs surface returns the campaign + per-citation
  // submission status from a SINGLE endpoint (no need for the old
  // two-call /v4/cb/get + /v2/cb/citations dance):
  //   GET https://api.brightlocal.com/manage/v1/citation-builder/{campaign_id}
  // Response shape (from the official Stoplight docs):
  //   {
  //     campaign_id, location_id, name, lookup_status,
  //     campaigns: [{
  //       campaign_id, package_id, paid,
  //       status: saved|confirmed|paid|on_hold|in_progress
  //               |submissions_complete|complete|finished,
  //       citations: [{ domain, type, status, profile_url, notes }],
  //       publishers: [{ name, directories: [...] }],
  //       citations_submission_status: { ordered, to_do, submitted,
  //                                      pending, live, ... },
  //     }],
  //     ...
  //   }
  let res: Response;
  try {
    res = await fetch(
      `${MANAGE_V1_BASE}/citation-builder/${encodeURIComponent(orderId)}`,
      {
        headers: {
          'x-api-key': config.apiKey,
          accept: 'application/json',
        },
      }
    );
  } catch (e) {
    return {
      ok: false,
      kind: 'remote_error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      kind: 'not_found',
      message: `BL campaign ${orderId} not found`,
    };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return {
      ok: false,
      kind: 'remote_error',
      message: `BL /manage/v1/citation-builder/${orderId} ${res.status}: ${truncate(text, 240)}`,
    };
  }
  let json: ManageV1CampaignResponse = {};
  try {
    json = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    /* fall through */
  }

  // Pick the most recent campaign aggregate; in practice there's
  // exactly one per submit, but the schema is an array so the
  // selection is explicit.
  const aggregate = (json.campaigns ?? [])[0];
  const status = normalizeManageV1Status(aggregate?.status);

  // Map BL's per-citation rows to our CitationDirectoryEntry shape.
  // BL returns citations as a flat array (no per-publisher nesting in
  // our case yet — publishers[] is for managed-network listings like
  // GPS Network/YP Network).
  const perDirectory: CitationDirectoryEntry[] = (aggregate?.citations ?? []).map(
    (c) => ({
      directory: c.domain ?? 'unknown',
      status: normalizeManageV1CitationStatus(c.status),
      submitted_at: null,
      live_at: null,
      url: c.profile_url ?? null,
      message: c.notes ?? null,
    })
  );

  return {
    ok: true,
    orderId,
    status,
    perDirectory,
    orderError: null,
  };
}

type ManageV1CitationRow = {
  domain?: string;
  type?: string;
  status?: string;
  profile_url?: string;
  notes?: string;
};

type ManageV1CampaignAggregate = {
  campaign_id?: number | string;
  status?: string;
  citations?: ManageV1CitationRow[];
};

type ManageV1CampaignResponse = {
  campaign_id?: number | string;
  location_id?: number | string;
  name?: string;
  lookup_status?: string;
  campaigns?: ManageV1CampaignAggregate[];
};

function normalizeManageV1Status(s: string | undefined): CitationOrderStatus {
  switch ((s ?? '').toLowerCase()) {
    case 'saved':
    case 'confirmed':
    case 'paid':
      return 'queued';
    case 'on_hold':
      return 'partial';
    case 'in_progress':
    case 'submissions_complete':
      return 'in_progress';
    case 'complete':
    case 'finished':
      return 'complete';
    default:
      return 'in_progress';
  }
}

function normalizeManageV1CitationStatus(
  s: string | undefined
): CitationDirectoryStatus {
  switch ((s ?? '').toLowerCase()) {
    case 'pending':
    case 'to_do':
    case 'ordered':
      return 'pending';
    case 'submitted':
      return 'submitted';
    case 'live':
    case 'updated':
    case 'existing':
    case 'replaced':
      return 'live';
    case 'omitted':
      return 'needs_review';
    case 'failed':
    case 'rejected':
      return 'failed';
    default:
      return 'pending';
  }
}

export async function pauseMaintenance(
  _orderId: string
): Promise<PauseMaintenanceResult> {
  const config = getConfig();
  if (!config.ok) return config;
  // BL's published Citation Builder examples don't include a "pause
  // syncing" endpoint. We mark maintenance_paused locally (which
  // stops the cron from polling) and surface a "manage on BL
  // dashboard" notice in the operator UI when this returns
  // 'remote_error'. Wire up the real endpoint when BL publishes one.
  return {
    ok: false,
    kind: 'remote_error',
    message:
      'BL Citation Builder pause endpoint not yet wired. Local maintenance_paused is set; pause sync on the BL dashboard if needed.',
  };
}

// ─── BL location resolution ────────────────────────────────────────────────

type EnsureLocationResult =
  | { ok: true; locationId: string; source: 'search' | 'create' }
  | {
      ok: false;
      error: {
        ok: false;
        kind: 'remote_error' | 'rate_limited' | 'invalid_profile';
        message: string;
      };
    };

/**
 * Find or create a BL "location" for this storefront and return the
 * BL location_id. Citation Builder requires this id on every campaign;
 * passing 1 (or any made-up id) returns 400 "Location ID is required."
 *
 * Idempotency: we set BL's `location-reference` to our turfmap
 * client_locations.id (UUID). The search endpoint accepts a freeform
 * `q` query that matches against name + reference, so re-submitting
 * for the same storefront finds the existing BL location instead of
 * creating a duplicate.
 */
async function ensureBlLocation(
  apiKey: string,
  input: SubmitOrderInput
): Promise<EnsureLocationResult> {
  // Step A — list all BL locations and client-side filter by
  // location-reference. The /search endpoint's `q` param matches
  // against location-name only (not the reference field), so a
  // q=<UUID> query returns nothing — but a parameterless search
  // returns the whole list as { success, locations: [{ location-id,
  // location-reference, ... }] }. We pick the one whose reference
  // matches our turfmap UUID. A naive list-all is fine for v1; if
  // an account ever exceeds BL's page-size limit (~50?) we'll need
  // to follow pagination here. NOTE: also necessary to recover from
  // the "already exists" race when an earlier submit attempt got
  // partway through and persisted the BL location but errored out
  // before we wrote the campaign.
  const search = await getJson(
    apiKey,
    '/v2/clients-and-locations/locations/search',
    {}
  );
  if (!search.ok) return { ok: false, error: search.error };
  const existingId = findLocationIdByReference(
    search.json,
    input.locationReference
  );
  if (existingId) return { ok: true, locationId: existingId, source: 'search' };

  // Step B — create. BL's location endpoint uses hyphenated keys
  // (vs underscored on /v4/cb/create) and a similar but distinct
  // opening-hours nested format with `apply-to-all` instead of
  // `apply_to_all`. Maintain two separate flatteners.
  const p = input.profile;
  const flatHours = flattenHoursForBlLocation(p.hours ?? {});
  const country = p.country_code ?? 'USA';
  const addPayload: Record<string, string> = {
    name: truncate(p.business_name, 100),
    'location-reference': input.locationReference,
    url: stripProtocol(p.website ?? ''),
    'business-category-id': String(FALLBACK_CATEGORY_ID),
    country,
    address1: p.street_address ?? '',
    address2: '',
    region: p.region ?? '',
    city: p.city ?? '',
    postcode: p.postcode ?? '',
    telephone: p.phone ?? '',
  };
  // BL's `language` enum is keyed `${COUNTRY}:${LANG}_${INDEX}`,
  // discovered via DOM inspection of BL's UI radio field:
  //   id="language_CAN:EN_0"  → English (Canada)
  //   id="language_CAN:FR_1"  → French (Canada)
  // Single-language countries (USA, GBR) accept omitted language;
  // multi-language ones (CAN, BEL, CHE, etc.) require an explicit
  // value. Default to English for our v1 audience; map other locales
  // here when we expand.
  const language = languageEnumFor(country);
  if (language) addPayload.language = language;
  Object.assign(addPayload, flatHours);

  const add = await postForm(
    apiKey,
    '/v2/clients-and-locations/locations/',
    addPayload
  );
  if (!add.ok) {
    // Recovery for the "already in use" race: list-all-then-filter
    // earlier in the function should have caught it, but if pagination
    // (or a stale-cache moment) lets a duplicate-create slip through,
    // BL returns "This location reference is already in use" — at
    // which point we know the location exists with our reference, so
    // re-search and pick it up.
    const msg = add.error.message;
    if (msg.includes('location reference is already in use')) {
      const recovery = await getJson(
        apiKey,
        '/v2/clients-and-locations/locations/search',
        {}
      );
      if (recovery.ok) {
        const recoveredId = findLocationIdByReference(
          recovery.json,
          input.locationReference
        );
        if (recoveredId) {
          return { ok: true, locationId: recoveredId, source: 'search' };
        }
      }
    }
    return { ok: false, error: add.error };
  }
  const newId = extractFirstLocationId(add.json);
  if (!newId) {
    return {
      ok: false,
      error: {
        ok: false,
        kind: 'remote_error',
        message: `BL location create response missing location id: ${truncate(JSON.stringify(add.json), 240)}`,
      },
    };
  }
  return { ok: true, locationId: newId, source: 'create' };
}

/** Walk BL's list-all-locations response and return the
 *  `location-id` of the entry whose `location-reference` exactly
 *  matches the one we passed. Response shape:
 *    { success: true, locations: [{ "location-id": N,
 *                                    "location-reference": "...",
 *                                    "location-name": "...", ... }] }
 *  Returns null if no entry matches. */
function findLocationIdByReference(
  json: unknown,
  reference: string
): string | null {
  const locations = (json as { locations?: Array<Record<string, unknown>> })
    ?.locations;
  if (!Array.isArray(locations)) return null;
  for (const loc of locations) {
    if (loc['location-reference'] === reference) {
      const id = loc['location-id'] ?? loc['location_id'] ?? loc['id'];
      if (typeof id === 'number' || typeof id === 'string') return String(id);
    }
  }
  return null;
}

function extractFirstLocationId(json: unknown): string | null {
  // BL's location-create response is flat: { "location-id": 4061294,
  // "success": true } — the smoke test confirmed this exact shape.
  // The search response wraps results in { response: { results: [...] } }.
  // We check both shapes + every plausible field naming (id /
  // location_id / location-id) since BL is inconsistent across
  // endpoints.
  const obj = json as Record<string, unknown> | null;
  if (!obj) return null;

  // Flat shape (create response).
  const flat = idFromAnyShape(obj);
  if (flat) return flat;

  // Wrapped shape (search / get response).
  const r = obj.response as Record<string, unknown> | undefined;
  if (!r) return null;
  const wrapped = idFromAnyShape(r);
  if (wrapped) return wrapped;
  const list =
    (r.results as Record<string, unknown>[] | undefined) ??
    (r.locations as Record<string, unknown>[] | undefined) ??
    [];
  if (list.length === 0) return null;
  return idFromAnyShape(list[0]!);
}

function idFromAnyShape(o: Record<string, unknown>): string | null {
  for (const k of ['location-id', 'location_id', 'id']) {
    const v = o[k];
    if (typeof v === 'number' || typeof v === 'string') return String(v);
  }
  return null;
}

/** BL's per-country language enum. Keys are ISO-3166-1 alpha-3
 *  country codes; values are BL's enum value (or null when the field
 *  should be omitted). Format derived from BL UI inspection:
 *  `${COUNTRY_CODE}:${LANG}_${RADIO_INDEX}` (the trailing `_N` is part
 *  of the canonical value, not a Symfony id suffix as one might
 *  assume — confirmed by Anthony via the BL Add-Location radio
 *  field markup). Default to English where the country supports it. */
function languageEnumFor(country: string): string | null {
  switch (country) {
    case 'CAN':
      // Symfony radio id `language_CAN:EN_0` → submitted value is
      // `CAN:EN` (the trailing `_0` is the radio index in the id, not
      // part of the choice value).
      return 'CAN:EN';
    case 'USA':
    case 'GBR':
      return null;
    default:
      return null;
  }
}

function flattenHoursForBlLocation(
  hours: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
  for (const day of days) {
    const v = hours[day];
    if (!v || v === 'closed') {
      out[`opening-hours[regular][${day}][status]`] = 'closed';
      continue;
    }
    if (v === '24h' || v === '24hrs') {
      out[`opening-hours[regular][${day}][status]`] = '24hrs';
      continue;
    }
    const [start, end] = v.split('-').map((s) => s.trim());
    if (!start || !end) {
      out[`opening-hours[regular][${day}][status]`] = 'closed';
      continue;
    }
    out[`opening-hours[regular][${day}][status]`] = 'open';
    out[`opening-hours[regular][${day}][hours][0][start]`] = start;
    out[`opening-hours[regular][${day}][hours][0][end]`] = end;
  }
  out['opening-hours[regular][apply-to-all]'] = 'false';
  return out;
}

// ─── Citation Builder campaign create (Management APIs surface) ────────────

const MANAGE_V1_BASE = 'https://api.brightlocal.com/manage/v1';

type CreateCampaignResult =
  | { ok: true; campaignId: string }
  | {
      ok: false;
      error: {
        ok: false;
        kind: 'remote_error' | 'rate_limited';
        message: string;
      };
    };

/**
 * BL Confirm Campaign — Management APIs equivalent of the deprecated
 * /v2/cb/confirm-and-pay endpoint. Confirms and pays for a campaign
 * with the configured package; BL bills against the account's credit
 * balance.
 *
 *   PUT https://api.brightlocal.com/manage/v1/citation-builder/{campaign_id}/confirm
 *   Header  x-api-key
 *   Header  Content-Type: application/json
 *   Body    {
 *     package_id: 'cb0'|'cb10'|'cb15'|'cb25'|'cb30'|'cb50'|'cb75'|'cb100',
 *     auto_select: boolean,           // false → citations[] required
 *     citations?: string[],            // domains, optional if auto_select
 *     publishers: string[],            // REQUIRED — country-specific
 *     remove_duplicates?: boolean,
 *     notes?: string,
 *     express?: boolean,
 *   }
 *   Resp    200 { message: 'Request successful.' }
 *
 * Docs: developer.brightlocal.com/docs/management-apis/l0fgjkxy8zp82-confirm-campaign
 *
 * The old /v2/cb/* path is deprecated — calling it silently 4xx'd
 * during the May 10 migration, leaving Sugar Daddy's campaign 965489
 * stuck in "Saved" state with no submissions queued. This is the
 * P0 fix.
 */
async function confirmCampaignManageV1(
  apiKey: string,
  campaignId: string,
  args: {
    packageId: string;
    countryCode3: string;
    directories?: string[] | null;
    notes?: string | null;
  }
): Promise<
  | { ok: true }
  | {
      ok: false;
      error: {
        ok: false;
        kind: 'remote_error' | 'rate_limited' | 'not_ready';
        message: string;
      };
    }
> {
  const publishers = publishersForCountry(args.countryCode3);
  const explicitDirs =
    args.directories && args.directories.length > 0 ? args.directories : null;
  const body: Record<string, unknown> = {
    package_id: args.packageId,
    auto_select: explicitDirs ? false : true,
    publishers,
    remove_duplicates: true,
  };
  if (explicitDirs) body.citations = explicitDirs;
  if (args.notes) body.notes = args.notes;

  let res: Response;
  try {
    res = await fetch(
      `${MANAGE_V1_BASE}/citation-builder/${encodeURIComponent(campaignId)}/confirm`,
      {
        method: 'PUT',
        headers: {
          'x-api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      }
    );
  } catch (e) {
    return {
      ok: false,
      error: {
        ok: false,
        kind: 'remote_error',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }
  if (res.status === 429) {
    return {
      ok: false,
      error: {
        ok: false,
        kind: 'rate_limited',
        message: 'BL rate limit reached on confirm — retry in 60s',
      },
    };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // BL returns 400 { errors: { not_ready: "Citation Tracker is searching
    // for citations for the campaign..." } } while its async lookup runs.
    // That's transient, not a real failure — flag it so the caller retries
    // / defers rather than marking the order failed.
    const notReady = /not_ready|searching for citations/i.test(text);
    return {
      ok: false,
      error: {
        ok: false,
        kind: notReady ? 'not_ready' : 'remote_error',
        message: `BL PUT /manage/v1/citation-builder/${campaignId}/confirm ${res.status}: ${truncate(text, 240)}`,
      },
    };
  }
  return { ok: true };
}

/**
 * Country-specific publisher whitelist. BL's confirm-campaign endpoint
 * requires the `publishers` array and rejects publishers that aren't
 * supported in the campaign's country. Mapping pulled verbatim from
 * the Stoplight docs (May 2026):
 *   USA: dataaxle, neustar, foursquare, gpsnetwork, ypnetwork
 *   Canada: dataaxle, foursquare, gpsnetwork
 *   Australia: foursquare, gpsnetwork, locafynetwork
 *   Other: foursquare, gpsnetwork
 *
 * Defaults to the USA list when country is unrecognized — at worst BL
 * rejects a publisher we shouldn't have included, which surfaces as a
 * loud 4xx the operator can investigate, rather than silently submitting
 * to too few sources.
 */
function publishersForCountry(country: string): string[] {
  const c = country.toUpperCase();
  if (c === 'USA' || c === 'US') {
    return ['dataaxle', 'neustar', 'foursquare', 'gpsnetwork', 'ypnetwork'];
  }
  if (c === 'CAN' || c === 'CA') {
    return ['dataaxle', 'foursquare', 'gpsnetwork'];
  }
  if (c === 'AUS' || c === 'AU') {
    return ['foursquare', 'gpsnetwork', 'locafynetwork'];
  }
  return ['foursquare', 'gpsnetwork'];
}

async function createCampaignManageV1(
  apiKey: string,
  blLocationId: string
): Promise<CreateCampaignResult> {
  const numericId = Number(blLocationId);
  if (!Number.isFinite(numericId)) {
    return {
      ok: false,
      error: {
        ok: false,
        kind: 'remote_error',
        message: `cannot create campaign — BL location id "${blLocationId}" is not numeric`,
      },
    };
  }
  const body = JSON.stringify({ location_id: numericId });
  let res: Response;
  try {
    res = await fetch(`${MANAGE_V1_BASE}/citation-builder`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body,
    });
  } catch (e) {
    return {
      ok: false,
      error: {
        ok: false,
        kind: 'remote_error',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }
  if (res.status === 429) {
    return {
      ok: false,
      error: {
        ok: false,
        kind: 'rate_limited',
        message: 'BL rate limit reached — retry in 60s',
      },
    };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return {
      ok: false,
      error: {
        ok: false,
        kind: 'remote_error',
        message: `BL /manage/v1/citation-builder ${res.status}: ${truncate(text, 240)}`,
      },
    };
  }
  let json: { campaign_id?: number | string } = {};
  try {
    json = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    /* fall through */
  }
  if (json.campaign_id == null) {
    return {
      ok: false,
      error: {
        ok: false,
        kind: 'remote_error',
        message: `BL create response missing campaign_id: ${truncate(text, 240)}`,
      },
    };
  }
  return { ok: true, campaignId: String(json.campaign_id) };
}

// ─── BL HTTP plumbing ──────────────────────────────────────────────────────

type PostResult =
  | { ok: true; status: number; json: unknown }
  | {
      ok: false;
      status: number | null;
      error: {
        ok: false;
        kind: 'remote_error' | 'rate_limited';
        message: string;
      };
    };

async function postForm(
  apiKey: string,
  path: string,
  body: Record<string, string>
): Promise<PostResult> {
  const url = `${BL_BASE}${path}?${authQuery(apiKey)}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) params.set(k, v);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    return parseResponse(res, path);
  } catch (e) {
    return {
      ok: false,
      status: null,
      error: {
        ok: false,
        kind: 'remote_error',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

type GetResult =
  | { ok: true; status: number; json: unknown }
  | {
      ok: false;
      status: number | null;
      error: { ok: false; kind: 'remote_error'; message: string };
    };

async function getJson(
  apiKey: string,
  path: string,
  params: Record<string, string>
): Promise<GetResult> {
  const qs = new URLSearchParams({ ...params, ...authParams(apiKey) });
  try {
    const res = await fetch(`${BL_BASE}${path}?${qs.toString()}`);
    const parsed = await parseResponse(res, path);
    if (parsed.ok) return parsed;
    // Pollers don't surface the rate-limited variant — they treat it
    // as a generic remote error and the cron retries on the next
    // sweep. Recast both kinds to remote_error.
    return {
      ok: false,
      status: parsed.status,
      error: {
        ok: false,
        kind: 'remote_error',
        message: parsed.error.message,
      },
    };
  } catch (e) {
    return {
      ok: false,
      status: null,
      error: {
        ok: false,
        kind: 'remote_error',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

async function parseResponse(
  res: Response,
  path: string
): Promise<PostResult> {
  if (res.status === 429) {
    return {
      ok: false,
      status: 429,
      error: {
        ok: false,
        kind: 'rate_limited',
        message: 'BL rate limit reached — retry in 60s',
      },
    };
  }
  let json: unknown = null;
  let text: string | null = null;
  try {
    text = await res.text();
    json = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: {
        ok: false,
        kind: 'remote_error',
        message: `BL ${path} ${res.status}: ${truncate(text ?? '(empty)', 240)}`,
      },
    };
  }
  return { ok: true, status: res.status, json };
}

async function uploadCampaignImage(
  apiKey: string,
  campaignId: string,
  contentType: string,
  filename: string,
  data: Uint8Array
): Promise<void> {
  const url = `${BL_BASE}/v2/cb/upload/${encodeURIComponent(campaignId)}/image?${authQuery(apiKey)}`;
  const fd = new FormData();
  fd.append(
    'file',
    new Blob([data as unknown as ArrayBuffer], { type: contentType }),
    filename
  );
  await fetch(url, { method: 'POST', body: fd });
  // Best-effort — caller swallows.
}

async function fetchPhotoBytes(
  url: string
): Promise<{ data: Uint8Array; contentType: string; filename: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    const filename = url.split('/').pop()?.split('?')[0] ?? 'photo.jpg';
    return { data: buf, contentType, filename };
  } catch {
    return null;
  }
}

// ─── Mapping helpers ───────────────────────────────────────────────────────

function mapProfileToCreatePayload(
  input: SubmitOrderInput,
  blLocationId: string
): Record<string, string> {
  const p = input.profile;

  // Categories: BL takes business_categories as a JSON-encoded array
  // of category names (the per-vertical id lookup is separate; we
  // pass FALLBACK_CATEGORY_ID for now).
  const categoriesList = [p.primary_category, ...(p.additional_categories ?? [])]
    .filter((c): c is string => Boolean(c?.trim()))
    .map((c) => c.trim());

  // Hours: BL wants
  //   opening_hours[regular][mon][status] = open|closed|24hrs|split
  //   opening_hours[regular][mon][hours][0][start] = HH:MM
  //   opening_hours[regular][mon][hours][0][end]   = HH:MM
  // application/x-www-form-urlencoded supports nested arrays via
  // bracket notation.
  const flatHours = flattenHoursForBl(p.hours ?? {});

  const payload: Record<string, string> = {
    // BL's /v4/cb/create example shows `location_id` (underscore) but
    // their response payloads use `location-id` (hyphen) — and the
    // underscored form was rejected as missing in production. Send
    // all three plausible variants; BL takes the one it expects and
    // ignores the rest.
    location_id: blLocationId,
    'location-id': blLocationId,
    locationId: blLocationId,
    campaign_name: truncate(`${p.business_name} — ${p.city ?? ''}`.trim(), 100),
    business_name: p.business_name,
    website_address: stripProtocol(p.website ?? ''),
    campaign_country: p.country_code ?? 'USA',
    campaign_city: p.city ?? '',
    campaign_state: p.region ?? '',
    business_category_id: String(FALLBACK_CATEGORY_ID),
    business_categories: JSON.stringify(categoriesList),
    address1: p.street_address ?? '',
    address2: '',
    city: p.city ?? '',
    region: p.region ?? '',
    postcode: p.postcode ?? '',
    contact_name: input.contact.lastname || input.contact.firstname || 'Owner',
    contact_firstname: input.contact.firstname || 'Owner',
    contact_telephone: p.phone ?? '',
    contact_email: input.contact.email,
    brief_description: truncate(p.description ?? '', 250),
    full_description: p.description ?? '',
  };
  Object.assign(payload, flatHours);
  return payload;
}

function flattenHoursForBl(
  hours: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
  for (const day of days) {
    const v = hours[day];
    if (!v || v === 'closed') {
      out[`opening_hours[regular][${day}][status]`] = 'closed';
      continue;
    }
    if (v === '24h' || v === '24hrs') {
      out[`opening_hours[regular][${day}][status]`] = '24hrs';
      continue;
    }
    // "HH:MM-HH:MM"
    const [start, end] = v.split('-').map((s) => s.trim());
    if (!start || !end) {
      out[`opening_hours[regular][${day}][status]`] = 'closed';
      continue;
    }
    out[`opening_hours[regular][${day}][status]`] = 'open';
    out[`opening_hours[regular][${day}][hours][0][start]`] = start;
    out[`opening_hours[regular][${day}][hours][0][end]`] = end;
  }
  out['opening_hours[regular][apply_to_all]'] = 'false';
  return out;
}

function extractCampaignId(json: unknown): string | null {
  const data = (json as { response?: { campaign_id?: number | string } })?.response;
  if (!data?.campaign_id) return null;
  return String(data.campaign_id);
}

function extractCampaignStatus(json: unknown): string | undefined {
  const data = (json as { response?: { status?: string } })?.response;
  return data?.status;
}

function extractCampaignError(json: unknown): string | null {
  const data = (json as { response?: { error?: string; errors?: unknown } })?.response;
  if (!data) return null;
  if (typeof data.error === 'string' && data.error.length > 0) return data.error;
  if (data.errors) {
    try {
      return truncate(JSON.stringify(data.errors), 400);
    } catch {
      return null;
    }
  }
  return null;
}

function extractCitationsList(json: unknown): Array<{
  directory?: string;
  citation_site?: string;
  status?: string;
  submitted_at?: string;
  live_at?: string;
  url?: string;
  citation_url?: string;
  message?: string;
  notes?: string;
}> {
  const data = (
    json as {
      response?: {
        results?: unknown[];
        citations?: unknown[];
      };
    }
  )?.response;
  const list = (data?.citations ?? data?.results ?? []) as Array<Record<string, unknown>>;
  return list.map((row) => ({
    directory:
      (row.directory as string | undefined) ??
      (row.citation_site as string | undefined),
    status: row.status as string | undefined,
    submitted_at: row.submitted_at as string | undefined,
    live_at: row.live_at as string | undefined,
    url: (row.url as string | undefined) ?? (row.citation_url as string | undefined),
    message: (row.message as string | undefined) ?? (row.notes as string | undefined),
  }));
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

function normalizeOrderStatus(s: string | undefined): CitationOrderStatus {
  switch ((s ?? '').toLowerCase()) {
    case 'queued':
    case 'pending':
    case 'awaiting_submission':
      return 'queued';
    case 'in_progress':
    case 'submitting':
    case 'processing':
    case 'live':
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
  return {
    directory: raw.directory ?? 'unknown',
    status: normalizeDirectoryStatus(raw.status),
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
    case 'awaiting_submission':
      return 'pending';
    case 'submitted':
    case 'in_progress':
      return 'submitted';
    case 'live':
    case 'success':
    case 'complete':
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

function authQuery(apiKey: string): string {
  return new URLSearchParams(authParams(apiKey)).toString();
}

function authParams(apiKey: string): Record<string, string> {
  // BL accepts api-key alone (sig+expires HMAC was deprecated in the
  // latest apiclient-php release; smoke test confirmed api-key-only
  // works against /v4/cb/get-all). We still send `expires` because
  // the docs reference it.
  return {
    'api-key': apiKey,
    expires: String(Math.floor(Date.now() / 1000) + 1800),
  };
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//i, '');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

function estimatePackageCostCents(packageId: string): number {
  // Calibrated against the BL `Add Campaign` step-2 invoice for Sugar
  // Daddy Doughnuts on 2026-05-17:
  //   - Manual submission unit price: $3.20 ($112 / 35 submissions)
  //   - Aggregator submission unit price: $28.50 (Data Axle, Foursquare,
  //     GPS Network — each)
  //   - 3-aggregator bundle discount: 5% (=> $85.50 instead of $90)
  //   - Optional add-on "Remove Harmful Duplicate Listings": $22.40
  //     (NOT included in these estimates — operator deselects in BL UI)
  //
  // Estimates here assume the buyer takes the package SKU's manual
  // count + 3 aggregators (default propagation set). Real wholesale
  // comes from BL invoicing; these are stored on citation_orders.
  // wholesale_cents so the operator dashboard's cost rollup has a
  // non-zero value to sort by.
  const aggregatorBundleCents = 8550; // $85.50 (3 aggregators, 5% bundle)
  const perManualCents = 320; // $3.20 per manual submission
  switch (packageId) {
    case 'cb15':
      return 15 * perManualCents + aggregatorBundleCents; // $48 + $85.50 = $133.50
    case 'cb25':
      return 25 * perManualCents + aggregatorBundleCents; // $80 + $85.50 = $165.50
    case 'cb50':
      return 50 * perManualCents + aggregatorBundleCents; // $160 + $85.50 = $245.50
    default:
      return 25 * perManualCents + aggregatorBundleCents; // match new default cb25
  }
}

function getConfig():
  | { ok: true; apiKey: string; packageId: string }
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
  return {
    ok: true,
    apiKey,
    packageId: process.env.BRIGHTLOCAL_CB_PACKAGE_ID ?? DEFAULT_PACKAGE_ID,
  };
}
