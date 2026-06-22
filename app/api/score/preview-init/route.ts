/**
 * POST /api/score/preview-init
 *
 * Entry point for the /score lead-magnet flow. Takes the lander
 * form's business + address + keyword + email, runs a free 81-point
 * scan, creates a preview-mode share link, returns the share_id for
 * the browser to redirect to /share/<id>.
 *
 * Throttling: 1 preview per email per UTC day + 5 per IP per UTC day.
 * Enforced via UNIQUE (key, day) on score_preview_throttle. The
 * insert returns 23505 on a duplicate; we map that to 429.
 *
 * Errors:
 *   400 — Zod body invalid
 *   429 — Email or IP rate-limited
 *   500 — Geocode / DB / scan failure (message in body)
 *   502 — Stripe / external dependency hiccup (not currently used,
 *         reserved for future)
 */

import { NextResponse, after } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { createPreviewClient } from '@/lib/score/createPreviewClient';
import { sendScoreUnlockNudge } from '@/lib/email/resend';
import { getTurfScoreBand } from '@/lib/metrics/turfScoreBands';
import { verifyTurnstileToken } from '@/lib/security/turnstile';
import {
  sendMetaCapiEvent,
  buildFbcFromFbclid,
} from '@/lib/marketing/metaCapi';

export const runtime = 'nodejs';
// Same ceiling as the paid scan-intake route — DFS + DB inserts +
// share-link create. Typical run ~30-60s; 300s gives headroom for
// tail latencies on a slow DFS day.
export const maxDuration = 300;

const Body = z.object({
  businessName: z.string().min(2).max(200),
  // Address is optional when a Google Business Profile is picked.
  // Service-area businesses (plumbers, HVAC, roofers — our ICP) hide
  // their street address on their GBP, so Place Details returns no
  // formattedAddress and the buyer can't supply one. The picked
  // listing's lat/lng seed the 81-point grid instead. The superRefine
  // below still requires a geocodable address on the no-GBP path
  // (homepage /score buyers who typed without picking a listing).
  address: z.string().max(400).optional(),
  keyword: z.string().min(2).max(160),
  email: z.string().email().max(320),
  phone: z.string().min(7).max(40),
  // Mapbox-picked geo. When BOTH present we skip Nominatim.
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  components: z
    .object({
      street_address: z.string().max(200).nullish(),
      city: z.string().max(120).nullish(),
      region: z.string().max(120).nullish(),
      postcode: z.string().max(20).nullish(),
      country_code: z.string().max(8).nullish(),
    })
    .optional(),
  // Attribution (for funnel analysis, not gating).
  utm_source: z.string().max(120).optional(),
  utm_medium: z.string().max(120).optional(),
  utm_campaign: z.string().max(200).optional(),
  utm_content: z.string().max(200).optional(),
  utm_term: z.string().max(200).optional(),
  gclid: z.string().max(200).optional(),
  fbclid: z.string().max(200).optional(),
  // Lander-level identifier — drives the unlock-price decision in
  // unlock-init. Known values today: 'score' (homepage CTA → $99) and
  // 'free_score' (cold-Meta lander → $49 MAPCHECK50). Free-text so
  // future landers can introduce their own slugs without a schema
  // migration; unlock-init pattern-matches against the known set and
  // falls back to $99 on unrecognized values (fail-closed).
  lead_source: z.string().max(64).optional(),
  // Cloudflare Turnstile token from the frontend widget. Optional
  // because the widget only renders when NEXT_PUBLIC_TURNSTILE_SITEKEY
  // is set; the server-side verifier mirrors that and skips when
  // TURNSTILE_SECRET_KEY is unset. Max length is the documented
  // Cloudflare token ceiling (~2048 chars).
  turnstile_token: z.string().max(4096).optional(),
  // Meta CAPI dedup id — client-generated UUID (crypto.randomUUID()
  // in the form). The client-side Pixel fires the SAME event_id, so
  // Facebook dedupes the two events.
  meta_event_id: z.string().max(120).optional(),
  // _fbp browser cookie value, read client-side from document.cookie.
  // Format: 'fb.<idx>.<creationTime>.<random>'. Forwarded raw for
  // CAPI user_data matching.
  fbp_cookie: z.string().max(200).optional(),
  // _fbc browser cookie value, set when an fbclid URL param is
  // present. Format: 'fb.<idx>.<creationTime>.<fbclid>'. We
  // reconstruct from raw fbclid if the cookie wasn't readable
  // client-side.
  fbc_cookie: z.string().max(400).optional(),
  // Source URL of the conversion (e.g. 'https://turfmap.ai/free-score').
  // Improves CAPI attribution match rate when present.
  event_source_url: z.string().url().max(1000).optional(),
  // Google Places fields when the buyer picked from the
  // PlaceAutocompleteElement on the lander (vs the legacy Mapbox
  // address path). Both optional — the form degrades gracefully
  // when the autocomplete isn't available.
  //
  // google_primary_type is THE canonical signal for the trade-
  // economics inference on /share/<id> — much more reliable than
  // regex-matching the buyer-typed keyword. Format is Google's
  // place_types enum: e.g. 'steak_house', 'plumber',
  // 'hair_salon', 'roofing_contractor'.
  google_place_id: z.string().max(300).optional(),
  google_primary_type: z.string().max(100).optional(),
  // /free-score-now QuizFlow extras. These were captured client-
  // side from the quiz steps but previously dropped on submit;
  // now stashed in stripe_metadata so the daily Slack recap +
  // future cohort analysis can slice by them.
  //   role        — owner | manager | agency  (the 'no' option
  //                 routes to disqualify and never reaches submit)
  //   trade       — slug from TRADES (roofing, hvac, renovation,
  //                 painting, landscaping, insulation, other)
  //   visibility  — buyer self-rating from before they saw their
  //                 actual score (top | mixed | unknown | invisible)
  // All optional — non-QuizFlow callers (ScanIntakeForm on
  // /free-score) don't send them; legacy leads have them absent.
  role: z.enum(['owner', 'manager', 'agency']).optional(),
  trade: z.string().max(40).optional(),
  visibility_self_rating: z
    .enum(['top', 'mixed', 'unknown', 'invisible'])
    .optional(),
}).superRefine((data, ctx) => {
  // GBP-picked intakes don't require an address (see the `address`
  // field note above) — the place_id + coordinates that ride along
  // with the pick are enough to seed the scan. Without a place_id we
  // fall back to requiring a geocodable address string.
  if (!data.google_place_id && (data.address ?? '').trim().length < 4) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['address'],
      message:
        'Address is required unless a Google Business Profile is selected.',
    });
  }
});

const RATE_LIMIT_PER_EMAIL_PER_DAY = 1;
const RATE_LIMIT_PER_IP_PER_DAY = 5;

/** Best-effort client IP extraction. Vercel sets x-forwarded-for in
 *  Fluid Compute; the first hop is the buyer's IP. Falls back to
 *  x-real-ip and finally to an empty string (which still rate-limits
 *  per email even if IP is unknown). */
function extractIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  return '';
}

export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof z.ZodError
            ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
            : 'invalid request body',
      },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();
  const email = body.email.trim().toLowerCase();
  const ip = extractIp(req);

  // ─── Cloudflare Turnstile verification ─────────────────────────────
  // Skipped when TURNSTILE_SECRET_KEY isn't set (local dev / pre-
  // setup deploy). Frontend widget also short-circuits when
  // NEXT_PUBLIC_TURNSTILE_SITEKEY isn't set, so the two sides agree.
  // Once BOTH env vars are set, every preview submission must carry
  // a valid token or it's rejected with 403.
  const turnstile = await verifyTurnstileToken({
    token: body.turnstile_token,
    remoteIp: ip || null,
  });
  if (!turnstile.ok) {
    return NextResponse.json(
      { error: turnstile.message, kind: turnstile.kind },
      { status: 403 }
    );
  }

  // ─── Rate limit: email ─────────────────────────────────────────────
  // Per the SPEC: 1 per email per UTC day. We attempt the insert
  // first; on conflict (23505) we know the buyer already used their
  // daily quota and return 429. Doing the check via INSERT (rather
  // than a SELECT-then-INSERT) keeps it race-free.
  const emailKey = `email:${email}`;
  const { error: emailRateErr } = await supabase
    .from('score_preview_throttle')
    .insert({
      key: emailKey,
      business_name: body.businessName.trim(),
      ip: ip || null,
      email,
    });
  if (emailRateErr) {
    const code = (emailRateErr as { code?: string }).code;
    if (code === '23505') {
      return NextResponse.json(
        {
          error:
            "You've already run a free TurfScore today. Come back tomorrow, or unlock the full scan now — same data, no waiting.",
          rateLimited: 'email',
        },
        { status: 429 }
      );
    }
    // Non-duplicate insert error — fail soft and continue. The
    // rate-limit log is a nice-to-have, not a hard dependency.
    console.warn(
      '[score/preview-init] email throttle insert failed:',
      emailRateErr.message
    );
  }

  // ─── Rate limit: IP ────────────────────────────────────────────────
  // 5 per IP per day. Implemented as a separate row with a different
  // key prefix so the UNIQUE constraint is independent of the email
  // check. We allow up to 5 distinct emails per IP per day, so the
  // insert is conditional on the existing count rather than UNIQUE
  // alone — query first.
  if (ip) {
    const ipKey = `ip:${ip}`;
    // IP-keyed rows are inserted as `ip:<addr>:<ts>` (the ts suffix lets
    // multiple rows/day coexist under UNIQUE(key, day)). So count by
    // PREFIX, not exact key — the old `.eq('key', ipKey)` matched the
    // bare `ip:<addr>` form that is never inserted, so this limit never
    // fired. IPs contain no LIKE wildcards (`%`/`_`) so the pattern is
    // safe. (Residual: count-then-insert isn't atomic, so a burst of
    // concurrent requests can slip a few past — acceptable for the
    // "casual scraping" threat model this throttle targets.)
    const { count: ipCount } = await supabase
      .from('score_preview_throttle')
      .select('id', { count: 'exact', head: true })
      .like('key', `${ipKey}:%`)
      .eq('day', new Date().toISOString().slice(0, 10));
    if ((ipCount ?? 0) >= RATE_LIMIT_PER_IP_PER_DAY) {
      return NextResponse.json(
        {
          error:
            "We've hit the daily free-scan limit from your network. Come back tomorrow, or unlock the full scan.",
          rateLimited: 'ip',
        },
        { status: 429 }
      );
    }
    // Insert the IP-keyed row alongside the email one. UNIQUE
    // (key, day) plus our manual count check above keep this from
    // exceeding RATE_LIMIT_PER_IP_PER_DAY in a single day.
    await supabase.from('score_preview_throttle').insert({
      key: `${ipKey}:${Date.now()}`, // suffix avoids 23505 within-day
      business_name: body.businessName.trim(),
      ip,
      email,
    });
  }

  // ─── Create preview client + run scan ──────────────────────────────
  const result = await createPreviewClient(supabase, {
    businessName: body.businessName,
    address: body.address ?? '',
    keyword: body.keyword,
    email,
    phone: body.phone,
    latitude: body.latitude,
    longitude: body.longitude,
    components: body.components ?? null,
    leadSource: body.lead_source ?? null,
    // Google fields when the buyer came through the new
    // PlaceAutocompleteElement on the lander. createPreviewClient
    // stamps them on the preview lead_orders row's stripe_metadata
    // so /share/<id> can read primary_type for the trade-economics
    // inference (much more reliable than keyword regex matching).
    googlePlaceId: body.google_place_id ?? null,
    googlePrimaryType: body.google_primary_type ?? null,
    attribution: {
      utm_source: body.utm_source ?? null,
      utm_medium: body.utm_medium ?? null,
      utm_campaign: body.utm_campaign ?? null,
      utm_content: body.utm_content ?? null,
      utm_term: body.utm_term ?? null,
      gclid: body.gclid ?? null,
      fbclid: body.fbclid ?? null,
    },
  });

  if (!result.ok) {
    const status =
      result.kind === 'geocode' ? 422 : result.kind === 'scan' ? 502 : 500;
    return NextResponse.json(
      { error: result.message, kind: result.kind },
      { status }
    );
  }

  // ─── Backfill the throttle rows with the resolved share/client ─────
  // Best-effort. Lets us trace a throttle hit back to the scan it
  // produced when debugging.
  void supabase
    .from('score_preview_throttle')
    .update({
      share_id: result.shareId,
      client_id: result.clientId,
    })
    .or(`key.eq.email:${email},email.eq.${email}`)
    .eq('day', new Date().toISOString().slice(0, 10));

  // ─── Stamp QuizFlow extras on the lead_orders row ─────────────────
  // /free-score-now captures role + trade + visibility self-rating
  // in the quiz steps and forwards them in the POST body. We patch
  // them onto the preview lead_orders row's stripe_metadata so the
  // daily Slack recap + cohort analysis can slice by them. Fields
  // are optional — non-QuizFlow callers (the long-scroll
  // /free-score form on ScanIntakeForm) don't send them and we
  // simply don't write the keys.
  //
  // Best-effort, fire-and-forget. A failed metadata patch would
  // only hide these signals from downstream reporting; the lead
  // itself + the preview unlock flow are already persisted.
  const quizExtras: Record<string, string> = {};
  if (body.role) quizExtras.role = body.role;
  if (body.trade) quizExtras.trade = body.trade;
  if (body.visibility_self_rating) {
    quizExtras.visibility_self_rating = body.visibility_self_rating;
  }
  if (Object.keys(quizExtras).length > 0) {
    void supabase
      .from('lead_orders')
      .select('id, stripe_metadata')
      .eq('client_id', result.clientId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{
        id: string;
        stripe_metadata: Record<string, string> | null;
      }>()
      .then(async ({ data: leadOrder }) => {
        if (!leadOrder) return;
        await supabase
          .from('lead_orders')
          .update({
            stripe_metadata: {
              ...(leadOrder.stripe_metadata ?? {}),
              ...quizExtras,
            },
          })
          .eq('id', leadOrder.id);
      });
  }

  // ─── 3-touch unlock drip ─────────────────────────────────────────
  // Fire touch 1 immediately so the buyer's inbox has the preview
  // link in case they bounce from /share before saving the URL.
  // Schedule touch 2 (+24h) and touch 3 (+72h) via Resend's
  // scheduled-send API; store the returned Resend ids on the
  // lead_orders.stripe_metadata so handleScoreUnlockCompletion can
  // cancel pending touches the moment the buyer pays $99.
  //
  // All three sends are fire-and-forget in after() — the buyer's
  // browser is already redirecting to /share, so failed/delayed
  // sends don't block their UX. RESEND_API_KEY missing in dev =
  // silent no-op (the resend helper logs but doesn't throw).
  const band = getTurfScoreBand(result.turfScore);
  const origin = new URL(req.url).origin;
  const previewUrl = `${origin}/share/${result.shareId}?utm_source=score_drip`;
  const now = Date.now();
  const scheduledTouch2 = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const scheduledTouch3 = new Date(now + 72 * 60 * 60 * 1000).toISOString();

  // Forward the lander slug into every drip touch so the email's
  // price strings match what unlock-init will charge (Meta cohorts
  // see $49 + MAPCHECK50; everyone else sees $99 list).
  const dripLeadSource = body.lead_source ?? null;

  after(async () => {
    const t1 = await sendScoreUnlockNudge({
      to: email,
      businessName: body.businessName.trim(),
      keyword: body.keyword.trim(),
      turfScore: result.turfScore,
      turfBand: band?.label ?? null,
      previewUrl,
      stage: 'touch_1',
      leadSource: dripLeadSource,
    });
    const t2 = await sendScoreUnlockNudge({
      to: email,
      businessName: body.businessName.trim(),
      keyword: body.keyword.trim(),
      turfScore: result.turfScore,
      turfBand: band?.label ?? null,
      previewUrl,
      stage: 'touch_2',
      scheduledAt: scheduledTouch2,
      leadSource: dripLeadSource,
    });
    const t3 = await sendScoreUnlockNudge({
      to: email,
      businessName: body.businessName.trim(),
      keyword: body.keyword.trim(),
      turfScore: result.turfScore,
      turfBand: band?.label ?? null,
      previewUrl,
      stage: 'touch_3',
      scheduledAt: scheduledTouch3,
      leadSource: dripLeadSource,
    });

    // Stamp the scheduled email ids on the lead_orders row so
    // handleScoreUnlockCompletion can cancel them when the buyer
    // pays. We look up the row by client_id (createPreviewClient
    // inserted exactly one row with source='score_preview' just
    // moments ago — UNIQUE-ish enough for this scope, and we
    // safely no-op if Resend didn't return an id).
    const metaPatch: Record<string, string> = {};
    if (t1.id) metaPatch.unlock_touch_1_email_id = t1.id;
    if (t2.id) metaPatch.unlock_touch_2_email_id = t2.id;
    if (t3.id) metaPatch.unlock_touch_3_email_id = t3.id;
    if (Object.keys(metaPatch).length === 0) return;

    const { data: leadOrder } = await supabase
      .from('lead_orders')
      .select('id, stripe_metadata')
      .eq('client_id', result.clientId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{
        id: string;
        stripe_metadata: Record<string, string> | null;
      }>();
    if (!leadOrder) return;

    await supabase
      .from('lead_orders')
      .update({
        stripe_metadata: {
          ...(leadOrder.stripe_metadata ?? {}),
          ...metaPatch,
        },
      })
      .eq('id', leadOrder.id);
  });

  // ─── Meta Conversions API — server-side Lead event ────────────────
  // Fired in addition to the client-side fbq('track', 'Lead') call so
  // Facebook can attribute the scan even when the Pixel is blocked
  // (iOS 14+ ATT opt-outs, ad blockers, browser tracking-prevention).
  // Both events share the same meta_event_id, so Facebook dedupes the
  // pair within ~48h.
  //
  // No-op when META_CAPI_ACCESS_TOKEN isn't set — same posture as
  // the email drip and the Turnstile verifier: silent skip in dev,
  // active in prod once the env var is wired.
  //
  // Wrapped in after() so the response isn't blocked on the
  // graph.facebook.com round-trip (~200-500ms).
  if (body.meta_event_id) {
    const userAgent = req.headers.get('user-agent');
    // Reconstruct the _fbc cookie from a raw fbclid if the client
    // didn't forward the cookie value (cookie was cleared between
    // page load + form submit, or the user pasted the URL directly).
    const fbc =
      body.fbc_cookie ??
      (body.fbclid ? buildFbcFromFbclid(body.fbclid) : null);
    const capiEventId = body.meta_event_id;
    const capiEmail = email;
    const capiPhone = body.phone;
    const capiIp = ip || null;
    const capiUserAgent = userAgent;
    const capiFbp = body.fbp_cookie ?? null;
    const capiFbc = fbc;
    const capiEventSourceUrl = body.event_source_url ?? null;
    // Lander identifier in custom_data lets Meta's reporting split
    // CAPI Leads by ad set / creative angle without us needing a
    // custom conversion definition per lander.
    const capiLeadSource = body.lead_source ?? null;
    const capiTurfScore = result.turfScore;

    after(async () => {
      const customData: Record<string, string | number | boolean> = {
        content_name: 'TurfScore Free Preview',
        content_category: 'score_preview_submit',
      };
      if (capiLeadSource) customData.lead_source = capiLeadSource;
      if (typeof capiTurfScore === 'number' && Number.isFinite(capiTurfScore)) {
        customData.turf_score = capiTurfScore;
      }

      const capiUserData = {
        email: capiEmail,
        phone: capiPhone,
        ip: capiIp,
        userAgent: capiUserAgent,
        fbp: capiFbp,
        fbc: capiFbc,
      };

      // Fire BOTH the generic standard Lead and a dedicated
      // 'FreeScoreSubmit' custom event. They share capiEventId — Meta
      // dedupes per (event_name, event_id), so the shared id only
      // dedupes each against its own client-side pixel fire, never
      // against the other. FreeScoreSubmit is the clean signal we
      // build a Custom Conversion on + optimize the lander campaign
      // toward; Lead stays for backwards-compatible reporting.
      const [leadResult, freeScoreResult] = await Promise.all([
        sendMetaCapiEvent({
          event: 'Lead',
          eventId: capiEventId,
          eventSourceUrl: capiEventSourceUrl,
          userData: capiUserData,
          customData,
        }),
        sendMetaCapiEvent({
          event: 'FreeScoreSubmit',
          eventId: capiEventId,
          eventSourceUrl: capiEventSourceUrl,
          userData: capiUserData,
          customData,
        }),
      ]);
      // Surface non-config failures in server logs so a misconfigured
      // access token or a graph API outage doesn't disappear silently.
      for (const [name, result] of [
        ['Lead', leadResult],
        ['FreeScoreSubmit', freeScoreResult],
      ] as const) {
        if (!result.ok && result.reason !== 'not_configured') {
          console.warn(
            `[score/preview-init] Meta CAPI ${name} failed:`,
            result.reason,
            result.message
          );
        }
      }
    });
  }

  return NextResponse.json({
    ok: true,
    share_id: result.shareId,
    share_url: `/share/${result.shareId}`,
    turfScore: result.turfScore,
  });
}

// Avoid TS6133 on the unused per-email constant — kept as a named
// constant so a future SQL trigger can read it.
void RATE_LIMIT_PER_EMAIL_PER_DAY;
