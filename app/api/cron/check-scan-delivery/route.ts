/**
 * Vercel Cron — scan-delivery health check.
 *
 * Schedule (vercel.json): daily at 12:00 UTC (~07:00 Eastern,
 * ~04:00 Pacific).
 *
 * Pairs with the 24-hour refund window in the TurfMap terms (see
 * docs/FOURDOTS_PRIVACY_TERMS_HANDOFF.md). Looks for clients that
 * paid in the last ~25 hours but have no completed scan yet —
 * those buyers are inside their refund window and at risk of
 * legitimately disputing if the issue isn't resolved before the
 * window closes. The operator gets a single alert email listing
 * all affected clients with deep-links into the agency dashboard
 * so they can manually fire a re-scan.
 *
 * Scoped to:
 *   - billing_mode in ('self_serve_subscription', 'one_time') —
 *     the two modes where the buyer paid via Stripe Checkout. Agency-
 *     managed clients are operator-onboarded; if their scan failed,
 *     it's not a refund-window issue, just an ops issue caught via
 *     normal review.
 *   - status != 'churned' — already-departed clients shouldn't
 *     trigger alerts.
 *
 * Lookback window: 24-25 hours. The 1-hour buffer past 24h covers
 * cron drift + the time between buyer purchase and the row landing
 * in our DB. Buyers more than 25 hours past purchase have already
 * exited the refund window — alerting on them now would be
 * after-the-fact noise.
 *
 * "No completed scan" check: count of scans for the client where
 * status='complete'. Zero means the buyer's heatmap dashboard is
 * still empty.
 *
 * Silent success: when no clients need attention, no email fires.
 * Anthony only hears from this cron when something genuinely needs
 * intervention.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` — Vercel Cron sets
 * this header automatically when CRON_SECRET is set on the project.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { sendDeliveryAlert } from '@/lib/email/resend';
import type { ClientRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = getServerSupabase();
  const now = Date.now();
  // 24-25 hour window. Buyers older than 25h have exited the
  // refund window; flagging them now would be after-the-fact.
  const windowStart = new Date(now - 25 * 60 * 60 * 1000).toISOString();
  const windowEnd = new Date(now - 0).toISOString(); // up to now

  const { data: candidates, error: cErr } = await supabase
    .from('clients')
    .select('id, public_id, business_name, billing_mode, created_at, pending_buyer_email')
    .in('billing_mode', ['self_serve_subscription', 'one_time'])
    .neq('status', 'churned')
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd)
    .returns<
      Pick<
        ClientRow,
        | 'id'
        | 'public_id'
        | 'business_name'
        | 'billing_mode'
        | 'created_at'
        | 'pending_buyer_email'
      >[]
    >();
  if (cErr) {
    return NextResponse.json(
      { error: `client query failed: ${cErr.message}` },
      { status: 500 }
    );
  }

  type AtRisk = {
    publicId: string;
    businessName: string;
    billingMode: string;
    createdAt: string;
    hoursSincePurchase: number;
    pendingBuyerEmail: string | null;
  };
  const atRisk: AtRisk[] = [];

  for (const client of candidates ?? []) {
    const { count } = await supabase
      .from('scans')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', client.id)
      .eq('status', 'complete');
    if ((count ?? 0) === 0) {
      const created = client.created_at
        ? new Date(client.created_at).getTime()
        : now;
      atRisk.push({
        publicId: client.public_id,
        businessName: client.business_name,
        billingMode: client.billing_mode,
        createdAt: client.created_at ?? '',
        hoursSincePurchase: Math.floor((now - created) / (60 * 60 * 1000)),
        pendingBuyerEmail: client.pending_buyer_email,
      });
    }
  }

  if (atRisk.length === 0) {
    // Silent success — no email. The cron's runtime telemetry on
    // Vercel still confirms it ran.
    return NextResponse.json({
      checked: candidates?.length ?? 0,
      at_risk: 0,
      emailed: false,
    });
  }

  // Send one consolidated alert. Anthony gets a list, not N emails.
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai';
  const alertTo =
    process.env.SCAN_DELIVERY_ALERT_TO ?? 'anthony@fourdots.io';
  const sent = await sendDeliveryAlert({
    to: alertTo,
    clients: atRisk.map((c) => ({
      businessName: c.businessName,
      publicId: c.publicId,
      hoursSincePurchase: c.hoursSincePurchase,
      billingMode: c.billingMode,
      buyerEmail: c.pendingBuyerEmail,
      dashboardUrl: `${origin}/clients/${c.publicId}`,
    })),
  });

  return NextResponse.json({
    checked: candidates?.length ?? 0,
    at_risk: atRisk.length,
    emailed: sent,
    alert_to: alertTo,
  });
}
