/**
 * GET /api/integrations/slack/connect?client=<public_id>
 *
 * Kicks off the Slack incoming-webhook OAuth flow. Verifies the
 * caller is agency staff (so a random visitor can't initiate a flow
 * on a client they don't own) and signs a short-lived state token
 * carrying the client's public_id. Redirects the operator's browser
 * to Slack's authorize URL.
 *
 * The callback at /api/integrations/slack/callback verifies the state
 * + exchanges the returned code for the per-channel webhook URL.
 *
 * Failure modes redirect to the settings page with a `?slack=...`
 * query so AlertPrefsCard can render a friendly inline error rather
 * than a JSON 503 the operator sees in the URL bar.
 */

import { NextResponse } from 'next/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { getServerSupabase } from '@/lib/supabase/server';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import {
  buildSlackAuthorizeUrl,
  signSlackState,
  slackRedirectUri,
} from '@/lib/integrations/slack';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const clientParam = url.searchParams.get('client');
  if (!clientParam) {
    return NextResponse.json(
      { error: 'client query param is required' },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();
  const client = await findClientByPublicIdOrUuid(supabase, clientParam);
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  const slackClientId = process.env.SLACK_CLIENT_ID;
  const slackSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const origin =
    process.env.NEXT_PUBLIC_APP_URL ??
    req.headers.get('origin') ??
    'https://turfmap.ai';
  const settingsUrl = `${origin}/clients/${client.public_id}/settings`;

  if (!slackClientId) {
    return NextResponse.redirect(
      `${settingsUrl}?slack=unavailable`,
      { status: 302 }
    );
  }
  if (!slackSecret) {
    return NextResponse.redirect(
      `${settingsUrl}?slack=server_misconfigured`,
      { status: 302 }
    );
  }

  const state = signSlackState({
    clientPublicId: client.public_id,
    secret: slackSecret,
  });
  const authorizeUrl = buildSlackAuthorizeUrl({
    clientId: slackClientId,
    state,
    redirectUri: slackRedirectUri(origin),
  });
  return NextResponse.redirect(authorizeUrl, { status: 302 });
}
