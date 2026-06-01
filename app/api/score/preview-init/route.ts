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

export const runtime = 'nodejs';
// Same ceiling as the paid scan-intake route — DFS + DB inserts +
// share-link create. Typical run ~30-60s; 300s gives headroom for
// tail latencies on a slow DFS day.
export const maxDuration = 300;

const Body = z.object({
  businessName: z.string().min(2).max(200),
  address: z.string().min(4).max(400),
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
  // Cloudflare Turnstile token from the frontend widget. Optional
  // because the widget only renders when NEXT_PUBLIC_TURNSTILE_SITEKEY
  // is set; the server-side verifier mirrors that and skips when
  // TURNSTILE_SECRET_KEY is unset. Max length is the documented
  // Cloudflare token ceiling (~2048 chars).
  turnstile_token: z.string().max(4096).optional(),
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
    const { count: ipCount } = await supabase
      .from('score_preview_throttle')
      .select('id', { count: 'exact', head: true })
      .eq('key', ipKey)
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
    address: body.address,
    keyword: body.keyword,
    email,
    phone: body.phone,
    latitude: body.latitude,
    longitude: body.longitude,
    components: body.components ?? null,
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

  after(async () => {
    const t1 = await sendScoreUnlockNudge({
      to: email,
      businessName: body.businessName.trim(),
      keyword: body.keyword.trim(),
      turfScore: result.turfScore,
      turfBand: band?.label ?? null,
      previewUrl,
      stage: 'touch_1',
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
