/**
 * verifyTurnstileToken — server-side validation of a Cloudflare
 * Turnstile token submitted by the frontend widget.
 *
 * Calls Cloudflare's siteverify endpoint with the token + the
 * server-side secret. Returns a discriminated result that the
 * route handler maps to either 200/200 (proceed) or 403 (failed
 * verification).
 *
 * Fail-soft behavior:
 *
 *   - When TURNSTILE_SECRET_KEY is unset → returns
 *     { ok: true, kind: 'skipped' }. This is the local-dev and
 *     pre-setup path; the frontend widget also short-circuits
 *     when NEXT_PUBLIC_TURNSTILE_SITEKEY is unset, so the two
 *     sides agree.
 *
 *   - When secret IS set but the frontend submitted an empty
 *     token → returns { ok: false, kind: 'missing' }. The widget
 *     emits empty on its own error paths (script-block, expire,
 *     etc.); we treat the absence as a verification failure to
 *     close the bypass path.
 *
 *   - When Cloudflare's siteverify returns success=false →
 *     { ok: false, kind: 'invalid', errorCodes }.
 *
 *   - Network failure → { ok: false, kind: 'unreachable' }. Caller
 *     decides whether to fail-closed (reject) or fail-open
 *     (proceed). v1 fails CLOSED (rejects) — verification is the
 *     point.
 *
 * Setup (operator-facing notes):
 *
 *   1. Cloudflare → Turnstile → Add Site → get sitekey + secret
 *   2. Set NEXT_PUBLIC_TURNSTILE_SITEKEY = <sitekey> in Vercel
 *      (both Production + Preview)
 *   3. Set TURNSTILE_SECRET_KEY = <secret> in Vercel (Production
 *      + Preview, NOT exposed via NEXT_PUBLIC_)
 *   4. Redeploy
 *
 * Until both are set, the form works without verification (rate
 * limits are the only abuse layer). Set both and verification
 * activates automatically — no code change.
 */

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type TurnstileVerificationResult =
  | { ok: true; kind: 'verified'; hostname: string | null }
  | { ok: true; kind: 'skipped' } // secret not configured
  | { ok: false; kind: 'missing'; message: string }
  | { ok: false; kind: 'invalid'; errorCodes: string[]; message: string }
  | { ok: false; kind: 'unreachable'; message: string };

export async function verifyTurnstileToken(args: {
  token: string | undefined | null;
  /** Best-effort client IP for Cloudflare's risk model. Pulled
   *  from x-forwarded-for upstream. Cloudflare's docs say
   *  remoteip is optional and only used as a signal. */
  remoteIp?: string | null;
}): Promise<TurnstileVerificationResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    return { ok: true, kind: 'skipped' };
  }
  const token = (args.token ?? '').trim();
  if (!token) {
    return {
      ok: false,
      kind: 'missing',
      message:
        'Bot-protection check is required. Please tick the verification box and resubmit.',
    };
  }

  // Cloudflare's siteverify takes a URL-encoded form body. JSON
  // body is also accepted as of late 2023 but form-encoded is the
  // documented stable shape.
  const form = new URLSearchParams();
  form.set('secret', secret);
  form.set('response', token);
  if (args.remoteIp) form.set('remoteip', args.remoteIp);

  let res: Response;
  try {
    res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      // Don't cache; each verification is a one-shot Cloudflare RPC.
      cache: 'no-store',
    });
  } catch (e) {
    return {
      ok: false,
      kind: 'unreachable',
      message: `Couldn't reach Cloudflare for bot check: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  let body: {
    success?: boolean;
    hostname?: string;
    challenge_ts?: string;
    'error-codes'?: string[];
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return {
      ok: false,
      kind: 'unreachable',
      message: `Cloudflare returned an unparseable response (HTTP ${res.status})`,
    };
  }

  if (body.success) {
    return {
      ok: true,
      kind: 'verified',
      hostname: body.hostname ?? null,
    };
  }

  const errorCodes = Array.isArray(body['error-codes'])
    ? body['error-codes']
    : [];
  return {
    ok: false,
    kind: 'invalid',
    errorCodes,
    message:
      errorCodes.length > 0
        ? `Bot-protection check rejected (${errorCodes.join(', ')}). Please reload and try again.`
        : 'Bot-protection check rejected. Please reload and try again.',
  };
}
