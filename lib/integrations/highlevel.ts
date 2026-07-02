/**
 * HighLevel (LeadConnector) client — TurfMap side.
 *
 * Companion to the Python lib/highlevel_rest.py in the Lead Gen repo.
 * Both use the same Private Integration Token (PIT) scoped to the
 * Fourdots agency sub-account (location CEuHYn0iVbIVxNxFKDn0) per
 * v2.2 §10.1 amended. Both enforce the cohort tag
 * `cold_outbound_q3_2026` on every contact upsert — this file is one of
 * only two sanctioned entry points for cold-outbound writes to GHL.
 *
 * Scope of this module (v2.2 P0.2b):
 *   - upsertScanViewedToGhl(): fires when a cold prospect views their
 *     scan. Upserts the contact into the Fourdots sub-account (email
 *     is the unique key), tags them with the cohort tag, and creates
 *     an opportunity in the "Cold Outbound Q3 2026" pipeline at the
 *     "Scan Viewed" stage. Fire-and-forget: swallows errors to console
 *     so a network hiccup can never break a lander render.
 *
 * NOT in this module (deferred):
 *   - SMS workflow trigger (P0.2c) — will call enrollWorkflow when
 *     Anthony has the workflow ID.
 *   - Calendar / appointment writes — go through the Lead Gen Python
 *     wrapper (bookings originate server-side from the /yourmap
 *     embedded calendar; not from here).
 *
 * Configuration (Vercel env vars — set once):
 *   HIGHLEVEL_PIT_TOKEN     = pit-...  (same as .secrets/highlevel.env)
 *   HIGHLEVEL_LOCATION_ID   = CEuHYn0iVbIVxNxFKDn0
 *   HIGHLEVEL_API_VERSION   = 2021-07-28  (optional; default set)
 *   HIGHLEVEL_API_BASE      = https://services.leadconnectorhq.com (optional)
 *
 * Pipeline / stage resolution is done LAZILY at first upsert and
 * cached at module scope for the lifetime of the lambda instance.
 * We resolve by NAME so nobody has to paste a stage UUID into an env
 * var; renaming stages in the GHL UI would break resolution, which
 * is deliberate — the code + UI stay in sync via the name contract.
 */

// Constants — single source of truth in code. If Anthony renames
// either in the UI he MUST update these strings same-commit.
const COHORT_TAG = 'cold_outbound_q3_2026';
const PIPELINE_NAME = 'Cold Outbound Q3 2026';
const SCAN_VIEWED_STAGE_NAME = 'Scan Viewed';

// Lazy-resolved cache. Set on first successful lookup; used on
// subsequent invocations within the same lambda instance.
let cachedPipelineId: string | null = null;
let cachedStageId: string | null = null;

type FetchOpts = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  params?: Record<string, string>;
};

async function ghlFetch(opts: FetchOpts): Promise<unknown> {
  const token = process.env.HIGHLEVEL_PIT_TOKEN;
  const locationId = process.env.HIGHLEVEL_LOCATION_ID;
  const version = process.env.HIGHLEVEL_API_VERSION || '2021-07-28';
  const base = (process.env.HIGHLEVEL_API_BASE || 'https://services.leadconnectorhq.com').replace(/\/$/, '');
  if (!token) throw new Error('HIGHLEVEL_PIT_TOKEN missing');
  if (!locationId) throw new Error('HIGHLEVEL_LOCATION_ID missing');

  const qs = opts.params
    ? '?' + new URLSearchParams(opts.params).toString()
    : '';
  const url = `${base}${opts.path}${qs}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Version: version,
    Accept: 'application/json',
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method: opts.method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    // Never let a slow GHL call hang a lander render. 10s is generous
    // for their typical p99 latency (~1-2s).
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GHL ${opts.method} ${opts.path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

async function resolvePipelineStage(): Promise<{ pipelineId: string; stageId: string }> {
  if (cachedPipelineId && cachedStageId) {
    return { pipelineId: cachedPipelineId, stageId: cachedStageId };
  }
  const locationId = process.env.HIGHLEVEL_LOCATION_ID!;
  const data = (await ghlFetch({
    method: 'GET',
    path: '/opportunities/pipelines',
    params: { locationId },
  })) as { pipelines?: Array<{ id: string; name: string; stages?: Array<{ id: string; name: string }> }> };

  const pipelines = data.pipelines ?? [];
  const pipeline = pipelines.find(
    (p) => (p.name ?? '').trim().toLowerCase() === PIPELINE_NAME.toLowerCase()
  );
  if (!pipeline) {
    throw new Error(
      `GHL pipeline "${PIPELINE_NAME}" not found (found ${pipelines.length} pipelines). ` +
        `Verify it exists in the Fourdots sub-account with that exact name.`
    );
  }
  const stage = (pipeline.stages ?? []).find(
    (s) => (s.name ?? '').trim().toLowerCase() === SCAN_VIEWED_STAGE_NAME.toLowerCase()
  );
  if (!stage) {
    throw new Error(
      `GHL stage "${SCAN_VIEWED_STAGE_NAME}" not found on pipeline "${PIPELINE_NAME}"`
    );
  }
  cachedPipelineId = pipeline.id;
  cachedStageId = stage.id;
  return { pipelineId: pipeline.id, stageId: stage.id };
}

export type ScanViewedInput = {
  prospect_id: string;
  email: string | null;
  first_name: string | null;
  business_name: string | null;
  trade: string | null;
  city: string | null;
  address: string | null;
  invisibility_count: number | null;
  top_competitor_name: string | null;
};

/**
 * Upsert prospect + create opportunity in "Scan Viewed" stage.
 *
 * Idempotent by design:
 *   - GHL's /contacts/upsert dedupes on email (per the sub-account's
 *     contactUniqueIdentifiers setting). Second call with the same
 *     email returns the existing contact.
 *   - Opportunity create isn't naturally idempotent, but the caller
 *     (scanViewedFanout) already dedupes 6h fanouts, so we only ever
 *     create one opp per prospect per window in practice.
 *
 * Safety:
 *   - Requires prospect.email. If null → logs + returns without
 *     touching GHL. Rationale: GHL upsert without email OR phone
 *     fails 422, and phone isn't reliably enriched on cold prospects.
 *     Later, when P1.5 enrichment fills phones, we relax this.
 *   - All errors caught + logged. This function never throws to the
 *     caller — a downstream ops signal must never break the page.
 */
export async function upsertScanViewedToGhl(p: ScanViewedInput): Promise<void> {
  if (!process.env.HIGHLEVEL_PIT_TOKEN) {
    console.warn('[highlevel] HIGHLEVEL_PIT_TOKEN not set — skipping GHL upsert');
    return;
  }
  if (!p.email) {
    console.warn(
      '[highlevel] scan view for prospect', p.prospect_id,
      'has no email — skipping GHL upsert (phone enrichment gates this in P1.5)'
    );
    return;
  }

  try {
    const locationId = process.env.HIGHLEVEL_LOCATION_ID!;
    const { pipelineId, stageId } = await resolvePipelineStage();

    // 1. Upsert contact — email as unique key, cohort tag enforced.
    const contactPayload: Record<string, unknown> = {
      locationId,
      email: p.email,
      source: 'yourmap_scan_view',
      tags: [COHORT_TAG],
      country: 'CA',
    };
    if (p.first_name) contactPayload.firstName = p.first_name;
    if (p.business_name) contactPayload.companyName = p.business_name;
    if (p.city) contactPayload.city = p.city;
    if (p.address) contactPayload.address1 = p.address;

    const upsertResp = (await ghlFetch({
      method: 'POST',
      path: '/contacts/upsert',
      body: contactPayload,
    })) as { contact?: { id?: string }; new_contact?: { id?: string }; id?: string };

    const contactId =
      upsertResp.contact?.id ?? upsertResp.new_contact?.id ?? upsertResp.id;
    if (!contactId) {
      console.warn(
        '[highlevel] upsert response missing contact id for', p.prospect_id,
        JSON.stringify(upsertResp).slice(0, 200)
      );
      return;
    }

    // 2. Create opportunity in Scan Viewed stage. The name doubles as
    // the row label in the GHL pipeline board — keep it human-legible.
    const oppName =
      [p.business_name, p.trade, p.city].filter(Boolean).join(' · ') ||
      `Prospect ${p.prospect_id}`;

    await ghlFetch({
      method: 'POST',
      path: '/opportunities/',
      body: {
        locationId,
        contactId,
        pipelineId,
        pipelineStageId: stageId,
        name: oppName,
        status: 'open',
      },
    });

    console.info(
      '[highlevel] scan view -> ghl ok:',
      p.prospect_id, '->', contactId,
      `(${oppName})`
    );
  } catch (e) {
    // The whole point of catching here: a GHL outage must never break
    // /yourmap. Log + move on. Every failure keeps the funnel alive
    // via the Slack ping that fired earlier in the same fanout.
    console.warn(
      '[highlevel] upsertScanViewedToGhl failed for prospect', p.prospect_id, ':',
      e instanceof Error ? e.message : String(e)
    );
  }
}
