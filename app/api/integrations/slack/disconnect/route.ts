/**
 * POST /api/integrations/slack/disconnect
 *
 * Clears all Slack-OAuth-derived columns on the client row. Doesn't
 * call Slack — the per-channel webhook URL just stops being POSTed
 * to. The buyer can also revoke the app from their Slack workspace
 * settings; that simply makes future POSTs 404, which our alert
 * dispatcher already handles silently.
 *
 * Body: { client_id }   (UUID)
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';

export const runtime = 'nodejs';

const Body = z.object({
  client_id: z.string().uuid(),
});

export async function POST(req: Request) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;

  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: e.issues.map((i) => i.message).join('; ') },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const supabase = getServerSupabase();
  const { error } = await supabase
    .from('clients')
    .update({
      slack_webhook_url: null,
      slack_team_name: null,
      slack_channel_name: null,
    })
    .eq('id', parsed.client_id);
  if (error) {
    return NextResponse.json(
      { error: `disconnect failed: ${error.message}` },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
