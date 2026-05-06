/**
 * Slack OAuth (incoming-webhook scope) helpers.
 *
 * Why incoming-webhook over chat:write: incoming-webhook returns a
 * per-channel POST URL with no token rotation, no refresh, no
 * permissions drift. The buyer picks the channel from Slack's native
 * picker UI during OAuth, we get back a webhook URL that's
 * permanently bound to that channel + workspace. Our existing alert
 * dispatch keeps POSTing to that URL — no changes downstream.
 *
 * State CSRF: we sign a short-lived token (10min TTL) carrying the
 * client's public_id with HMAC-SHA256. The signing secret is the
 * STRIPE_WEBHOOK_SECRET env (already required for the Stripe webhook;
 * server-only and rotates rarely). On callback we verify the HMAC +
 * timestamp before exchanging the code. No cookie needed.
 *
 * Env vars (production + preview):
 *   SLACK_CLIENT_ID              — public, set on the Slack app's
 *                                  Basic Information page
 *   SLACK_CLIENT_SECRET          — server-side secret, same page
 *   STRIPE_WEBHOOK_SECRET        — already set; reused as HMAC key
 *   NEXT_PUBLIC_APP_URL          — origin used in redirect_uri
 *
 * The Slack app must have:
 *   - OAuth scope `incoming-webhook` on Bot Token Scopes
 *   - Redirect URL `${NEXT_PUBLIC_APP_URL}/api/integrations/slack/callback`
 *   - Public Distribution activated
 */

import crypto from 'node:crypto';

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const STATE_VERSION = 'v1';

/** Build the authorize URL the operator's browser is redirected to.
 *  Slack handles workspace + channel selection on its own UI; we just
 *  request the scope and pass our redirect + state. */
export function buildSlackAuthorizeUrl(args: {
  clientId: string; // Slack app client_id (env)
  state: string;
  redirectUri: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    scope: 'incoming-webhook',
    state: args.state,
    redirect_uri: args.redirectUri,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

/** Sign a client_public_id + issuance timestamp with HMAC-SHA256.
 *  Format: `v1.<base64url(payload)>.<base64url(sig)>` where
 *  payload = `${publicId}:${issuedAtMs}`. */
export function signSlackState(args: {
  clientPublicId: string;
  secret: string;
}): string {
  const payload = `${args.clientPublicId}:${Date.now()}`;
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto
    .createHmac('sha256', args.secret)
    .update(payloadB64)
    .digest('base64url');
  return `${STATE_VERSION}.${payloadB64}.${sig}`;
}

export type VerifiedState = {
  ok: true;
  clientPublicId: string;
  issuedAtMs: number;
} | {
  ok: false;
  reason: 'malformed' | 'bad_signature' | 'expired';
};

/** Verify a state token returned by Slack. Constant-time signature
 *  comparison + timestamp check. */
export function verifySlackState(args: {
  state: string;
  secret: string;
}): VerifiedState {
  const parts = args.state.split('.');
  if (parts.length !== 3 || parts[0] !== STATE_VERSION) {
    return { ok: false, reason: 'malformed' };
  }
  const [, payloadB64, sigB64] = parts;
  const expectedSig = crypto
    .createHmac('sha256', args.secret)
    .update(payloadB64)
    .digest('base64url');
  // Constant-time compare to avoid timing attacks.
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }
  const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  const colon = payload.indexOf(':');
  if (colon < 0) return { ok: false, reason: 'malformed' };
  const clientPublicId = payload.slice(0, colon);
  const issuedAtMs = Number(payload.slice(colon + 1));
  if (!Number.isFinite(issuedAtMs)) {
    return { ok: false, reason: 'malformed' };
  }
  if (Date.now() - issuedAtMs > STATE_TTL_MS) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, clientPublicId, issuedAtMs };
}

export type SlackOAuthResult =
  | {
      ok: true;
      webhookUrl: string;
      teamName: string;
      channelName: string;
    }
  | {
      ok: false;
      kind: 'http_error' | 'api_error' | 'missing_fields';
      message: string;
    };

/** Exchange an OAuth `code` for an incoming-webhook URL via Slack's
 *  oauth.v2.access endpoint. Returns the webhook URL + display
 *  metadata (team + channel name). */
export async function exchangeSlackCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<SlackOAuthResult> {
  const body = new URLSearchParams({
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
  });
  let res: Response;
  try {
    res = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (e) {
    return {
      ok: false,
      kind: 'http_error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      kind: 'http_error',
      message: `Slack returned ${res.status}`,
    };
  }
  const json = (await res.json()) as {
    ok: boolean;
    error?: string;
    team?: { name?: string };
    incoming_webhook?: { url?: string; channel?: string };
  };
  if (!json.ok) {
    return {
      ok: false,
      kind: 'api_error',
      message: json.error ?? 'unknown Slack OAuth error',
    };
  }
  const webhookUrl = json.incoming_webhook?.url;
  const teamName = json.team?.name ?? '';
  const channelName = json.incoming_webhook?.channel ?? '';
  if (!webhookUrl) {
    return {
      ok: false,
      kind: 'missing_fields',
      message: 'Slack OAuth response missing incoming_webhook.url',
    };
  }
  return { ok: true, webhookUrl, teamName, channelName };
}

export function slackRedirectUri(origin: string): string {
  return `${origin}/api/integrations/slack/callback`;
}
