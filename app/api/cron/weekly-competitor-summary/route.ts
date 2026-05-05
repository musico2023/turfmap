/**
 * Vercel Cron — weekly competitor-movement summary email.
 *
 * Schedule (vercel.json): Mondays at 13:00 UTC (8am US Eastern).
 *
 * For each Pulse / Pulse+ / agency-managed client whose alert_prefs
 * have weekly_competitor_summary_email = true:
 *   1. Pull competitor names observed this week (last 7 days of
 *      complete scans for the client's primary location).
 *   2. Pull competitor names from the prior 7-day window for diff.
 *   3. Send an email summarizing entries / exits / persistent
 *      competitors. Skip clients with no scan activity in either
 *      window.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}.
 *
 * Returns: { processed, sent, errors }
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getServerSupabase } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/email/resend';
import { extractCompetitorNames } from '@/lib/alerts/diff';
import { withAlertPrefDefaults } from '@/lib/alerts/prefs';
import type {
  ClientLocationRow,
  ClientRow,
  ScanPointRow,
  ScanRow,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured on server' },
      { status: 503 }
    );
  }
  if (req.headers.get('authorization') !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = getServerSupabase();
  const now = Date.now();
  const thisWeekStart = new Date(now - WEEK_MS).toISOString();
  const lastWeekStart = new Date(now - 2 * WEEK_MS).toISOString();

  const { data: clients } = await supabase
    .from('clients')
    .select(
      'id, public_id, business_name, billing_mode, status, alert_prefs'
    )
    .in('billing_mode', ['agency_managed', 'self_serve_subscription'])
    .neq('status', 'churned')
    .returns<
      Pick<
        ClientRow,
        | 'id'
        | 'public_id'
        | 'business_name'
        | 'billing_mode'
        | 'status'
        | 'alert_prefs'
      >[]
    >();

  let processed = 0;
  let sent = 0;
  const errors: Array<{ clientId: string; message: string }> = [];

  for (const client of clients ?? []) {
    const prefs = withAlertPrefDefaults(client.alert_prefs);
    if (!prefs.weekly_competitor_summary_email) continue;
    processed += 1;
    try {
      const result = await sendWeeklySummaryForClient(
        supabase,
        client,
        thisWeekStart,
        lastWeekStart
      );
      sent += result.sent;
      if (result.error) {
        errors.push({ clientId: client.id, message: result.error });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ clientId: client.id, message: msg });
    }
  }

  return NextResponse.json({ processed, sent, errors });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

async function sendWeeklySummaryForClient(
  supabase: SupabaseLike,
  client: Pick<ClientRow, 'id' | 'public_id' | 'business_name'>,
  thisWeekStart: string,
  lastWeekStart: string
): Promise<{ sent: number; error: string | null }> {
  const { data: location } = await supabase
    .from('client_locations')
    .select('id')
    .eq('client_id', client.id)
    .eq('is_primary', true)
    .maybeSingle<Pick<ClientLocationRow, 'id'>>();
  if (!location) return { sent: 0, error: 'no primary location' };

  // Pull all complete scans in the last 14 days for the primary
  // location. We split them by completed_at into "this week" + "last
  // week" buckets in JS rather than firing two queries.
  const { data: scans } = await supabase
    .from('scans')
    .select('id, completed_at')
    .eq('client_id', client.id)
    .eq('location_id', location.id)
    .eq('status', 'complete')
    .gte('completed_at', lastWeekStart)
    .returns<Pick<ScanRow, 'id' | 'completed_at'>[]>();
  const scanList = scans ?? [];
  if (scanList.length === 0) {
    return { sent: 0, error: null }; // no activity, no email
  }
  const thisWeekScanIds = scanList
    .filter(
      (s: Pick<ScanRow, 'id' | 'completed_at'>) =>
        s.completed_at !== null && s.completed_at >= thisWeekStart
    )
    .map((s: Pick<ScanRow, 'id' | 'completed_at'>) => s.id);
  const lastWeekScanIds = scanList
    .filter(
      (s: Pick<ScanRow, 'id' | 'completed_at'>) =>
        s.completed_at !== null &&
        s.completed_at >= lastWeekStart &&
        s.completed_at < thisWeekStart
    )
    .map((s: Pick<ScanRow, 'id' | 'completed_at'>) => s.id);

  if (thisWeekScanIds.length === 0) {
    return { sent: 0, error: null };
  }

  // Pull scan_points for both windows. The competitor name aggregation
  // is identical to the post-scan path — extractCompetitorNames in
  // lib/alerts/diff.
  const [{ data: thisWeekPts }, { data: lastWeekPts }] = await Promise.all([
    supabase
      .from('scan_points')
      .select('competitors')
      .in('scan_id', thisWeekScanIds)
      .returns<Pick<ScanPointRow, 'competitors'>[]>(),
    lastWeekScanIds.length > 0
      ? supabase
          .from('scan_points')
          .select('competitors')
          .in('scan_id', lastWeekScanIds)
          .returns<Pick<ScanPointRow, 'competitors'>[]>()
      : Promise.resolve({
          data: [] as Pick<ScanPointRow, 'competitors'>[],
        }),
  ]);

  const thisWeekNames = extractCompetitorNames(thisWeekPts ?? []);
  const lastWeekNames = extractCompetitorNames(lastWeekPts ?? []);
  const lastSet = new Set(lastWeekNames.map((n) => n.toLowerCase().trim()));
  const thisSet = new Set(thisWeekNames.map((n) => n.toLowerCase().trim()));
  const entries = thisWeekNames.filter(
    (n) => !lastSet.has(n.toLowerCase().trim())
  );
  const exits = lastWeekNames.filter(
    (n) => !thisSet.has(n.toLowerCase().trim())
  );
  const persistent = thisWeekNames.filter((n) =>
    lastSet.has(n.toLowerCase().trim())
  );

  const { data: portalUsers } = await supabase
    .from('client_users')
    .select('email')
    .eq('client_id', client.id)
    .returns<{ email: string }[]>();
  const recipients = (portalUsers ?? [])
    .map((u: { email: string }) => u.email)
    .filter(Boolean);
  if (recipients.length === 0) {
    return { sent: 0, error: 'no portal users to email' };
  }

  const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai';
  const portalUrl = `${origin}/portal/${client.public_id}`;
  const subject = `Weekly competitor summary — ${client.business_name}`;
  const html = `<!DOCTYPE html><html><body style="background:#0a0a0a;color:#e4e4e7;font-family:-apple-system,sans-serif;padding:32px;">
    <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#0d0d0d;border:1px solid #27272a;border-radius:8px;padding:28px;">
      <tr><td>
        <span style="display:inline-block;padding:6px 10px;background:#c5ff3a;color:#000;font-weight:700;border-radius:4px;font-size:13px;">TurfMap</span>
        <h1 style="font-size:22px;color:#ededed;margin:24px 0 12px;">${escapeHtml(client.business_name)} — last 7 days.</h1>
        ${section('🆕 New entrants', entries, '#c5ff3a')}
        ${section('↘ Dropped out', exits, '#a1a1aa')}
        ${section('Holding ground', persistent, '#e4e4e7')}
        <p style="margin:28px 0 0;"><a href="${portalUrl}" style="display:inline-block;padding:12px 20px;background:#c5ff3a;color:#000;font-weight:700;text-decoration:none;border-radius:6px;font-size:15px;">Open dashboard →</a></p>
      </td></tr>
    </table>
  </body></html>`;
  const text = `${client.business_name} — last 7 days.\nNew entrants: ${entries.join(', ') || 'none'}\nDropped out: ${exits.join(', ') || 'none'}\nHolding ground: ${persistent.join(', ') || 'none'}\n${portalUrl}`;

  let sent = 0;
  for (const to of recipients) {
    const ok = await sendEmail({ to, subject, html, text });
    if (ok) sent += 1;
  }
  return { sent, error: null };
}

function section(
  title: string,
  names: string[],
  color: string
): string {
  if (names.length === 0) {
    return `<p style="color:#52525b;font-size:13px;margin:8px 0;"><strong style="color:${color};">${title}:</strong> none.</p>`;
  }
  return `<p style="color:#a1a1aa;font-size:13px;margin:8px 0;line-height:1.6;"><strong style="color:${color};">${title}:</strong> ${names
    .map(escapeHtml)
    .join(', ')}.</p>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
