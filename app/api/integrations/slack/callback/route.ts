/**
 * GET /api/integrations/slack/callback?code=...&state=...
 *
 * Slack OAuth landing page. Verifies the signed state token,
 * exchanges the code for an incoming-webhook URL via Slack's
 * oauth.v2.access, and writes the result onto the client row.
 * Redirects back to the agency settings page with a success/error
 * query param.
 *
 * No agency-auth check here: the redirect comes from slack.com, not
 * from the operator's session. The state HMAC + 10min TTL is the
 * gate. Once verified, the public_id encoded in the state identifies
 * the client to update.
 *
 * Slack also redirects here with `?error=access_denied` when the
 * operator clicks Cancel in Slack's consent UI. We surface that as
 * a clean "connection cancelled" notice rather than a generic error.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { findClientByPublicIdOrUuid } from '@/lib/supabase/client-lookup';
import { agencyClientUrl } from '@/lib/urls';
import {
  exchangeSlackCode,
  slackRedirectUri,
  verifySlackState,
} from '@/lib/integrations/slack';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin =
    process.env.NEXT_PUBLIC_APP_URL ??
    req.headers.get('origin') ??
    'https://turfmap.ai';

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  // Operator clicked Cancel in Slack's consent UI. We don't have a
  // signed state to identify the client deterministically (the state
  // wasn't signed for cancel paths), so redirect to /clients with a
  // toast — the operator can re-click "Add to Slack" from any client.
  if (error) {
    return NextResponse.redirect(
      `${origin}/clients?slack=cancelled`,
      { status: 302 }
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      `${origin}/clients?slack=invalid_callback`,
      { status: 302 }
    );
  }

  const slackSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!slackSecret) {
    return NextResponse.redirect(
      `${origin}/clients?slack=server_misconfigured`,
      { status: 302 }
    );
  }

  const verified = verifySlackState({ state, secret: slackSecret });
  if (!verified.ok) {
    return NextResponse.redirect(
      `${origin}/clients?slack=invalid_state&reason=${verified.reason}`,
      { status: 302 }
    );
  }

  const supabase = getServerSupabase();
  const client = await findClientByPublicIdOrUuid(
    supabase,
    verified.clientPublicId
  );
  if (!client) {
    return NextResponse.redirect(
      `${origin}/clients?slack=client_not_found`,
      { status: 302 }
    );
  }
  const settingsUrl = `${agencyClientUrl(origin, client.public_id)}/settings`;

  const slackClientId = process.env.SLACK_CLIENT_ID;
  const slackClientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!slackClientId || !slackClientSecret) {
    return NextResponse.redirect(
      `${settingsUrl}?slack=unavailable`,
      { status: 302 }
    );
  }

  const result = await exchangeSlackCode({
    clientId: slackClientId,
    clientSecret: slackClientSecret,
    code,
    redirectUri: slackRedirectUri(origin),
  });
  if (!result.ok) {
    return NextResponse.redirect(
      `${settingsUrl}?slack=exchange_failed&reason=${encodeURIComponent(result.message)}`,
      { status: 302 }
    );
  }

  const { error: updateError } = await supabase
    .from('clients')
    .update({
      slack_webhook_url: result.webhookUrl,
      slack_team_name: result.teamName || null,
      slack_channel_name: result.channelName || null,
    })
    .eq('id', client.id);
  if (updateError) {
    return NextResponse.redirect(
      `${settingsUrl}?slack=db_error&reason=${encodeURIComponent(updateError.message)}`,
      { status: 302 }
    );
  }

  return NextResponse.redirect(
    `${settingsUrl}?slack=connected`,
    { status: 302 }
  );
}
