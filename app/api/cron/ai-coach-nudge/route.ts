/**
 * Vercel Cron — AI Coach engagement nudge.
 *
 * Schedule (vercel.json):
 *   "/api/cron/ai-coach-nudge"  every 15 min
 *
 * Why this cron exists: the first real VIP buyer (Ryan / BVM
 * Contracting, May 12 2026) opened his dashboard within 1 second of
 * conversion but never clicked Generate on the AI Coach. Stage 2
 * (audit upgrade) fired anyway, and we lost the chance to deepen
 * engagement before the upsell. AI Coach is the upsell-bridge surface
 * inside the free TurfScan; nudging non-engagers back to it improves
 * the conversion rate of every downstream funnel.
 *
 * Trigger conditions for each prospect row (all must be true):
 *   - prospects.converted_at IS NOT NULL              (purchased)
 *   - prospects.scan_engaged_at IS NOT NULL           (viewed dashboard)
 *   - prospects.ai_coach_nudge_sent_at IS NULL        (not nudged before)
 *   - NOW() - scan_engaged_at >= 1 hr                 (gave them a chance)
 *   - NOW() - scan_engaged_at <= 7 days               (still warm enough)
 *   - prospect has a fulfilled lead_orders row with client_id set
 *   - the buyer's client has a completed scan
 *   - NO ai_insights row exists for the buyer's most-recent scan
 *
 * Cohort scope: BOTH cold_email and crm_reactivation_q2. The nudge is
 * behaviorally neutral — "you didn't click the button" doesn't depend
 * on how the buyer got here.
 *
 * Per qualifying prospect:
 *   1. Build dashboard URL = `/portal/{public_id}#ai-coach`
 *   2. Render + send the nudge email via Resend
 *   3. UPDATE prospects SET ai_coach_nudge_sent_at = NOW()
 *
 * Idempotency: ai_coach_nudge_sent_at IS NULL filter + immediate stamp
 * write makes this safe even if Vercel double-fires the cron (at-least-
 * once semantics).
 *
 * Silent success: returns 200 with { sent: 0 } when no prospects
 * qualify. Anthony only sees errors in logs.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` — Vercel sets this
 * automatically when the env var is configured.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { Resend } from 'resend';
import { render } from '@react-email/components';
import AICoachNudgeEmail, {
  pickSubject,
} from '@/components/email/AICoachNudgeEmail';
import { portalUrl } from '@/lib/urls';

export const runtime = 'nodejs';
export const maxDuration = 60;

const FROM_ADDRESS =
  process.env.RESEND_FROM_ADDRESS ?? 'Anthony at TurfMap <hi@turfmap.ai>';

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}`;
}

type ProspectCandidate = {
  id: string;
  business_name: string;
  first_name: string | null;
  email: string | null;
};

type LeadOrderJoin = {
  id: string;
  client_id: string | null;
  stripe_metadata: Record<string, unknown> | null;
};

async function handle(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return NextResponse.json(
      { error: 'RESEND_API_KEY not configured' },
      { status: 503 }
    );
  }

  const supabase = getServerSupabase();
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai';

  // ─── 1. Find prospects in the nudge window ──────────────────────────
  // 1 hr ≤ NOW − scan_engaged_at ≤ 7 days. Below 1 hr we haven't given
  // them a fair shot; above 7 days the lead is cold and a fresh email
  // about the AI Coach reads as spammy.
  const nowMs = Date.now();
  const hr1AgoIso = new Date(nowMs - 60 * 60 * 1000).toISOString();
  const days7AgoIso = new Date(
    nowMs - 7 * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: candidates, error: candErr } = await supabase
    .from('prospects')
    .select('id, business_name, first_name, email')
    .not('converted_at', 'is', null)
    .not('scan_engaged_at', 'is', null)
    .is('ai_coach_nudge_sent_at', null)
    .lte('scan_engaged_at', hr1AgoIso)
    .gte('scan_engaged_at', days7AgoIso);

  if (candErr) {
    console.error('[ai-coach-nudge] supabase query failed:', candErr);
    return NextResponse.json(
      { error: 'supabase_query_failed', message: candErr.message },
      { status: 500 }
    );
  }

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ scanned: 0, sent: 0 });
  }

  // ─── 2. Per prospect: link to client → scan → ai_insights ───────────
  // Each step is a small query rather than a fancy join. The cron's
  // candidate set is small (target population is a few hundred rows
  // max across cold + warm in any 7-day window), so the join cost is
  // negligible and keeping the steps separate makes the failure modes
  // legible in logs.
  const resend = new Resend(resendKey);
  let sent = 0;
  const errors: Array<{ prospect_id: string; message: string }> = [];

  for (const p of candidates as ProspectCandidate[]) {
    if (!p.email || !p.first_name) {
      errors.push({
        prospect_id: p.id,
        message: 'missing first_name or email — skipped',
      });
      continue;
    }

    try {
      // 2a. Find the lead_orders row for this prospect via the
      //     stripe_metadata->prospect_id pointer. There can be more
      //     than one row if the buyer refunded + re-purchased; we
      //     take the most recent.
      const { data: orders, error: orderErr } = await supabase
        .from('lead_orders')
        .select('id, client_id, stripe_metadata')
        .filter('stripe_metadata->>prospect_id', 'eq', p.id)
        .not('client_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1);

      if (orderErr) {
        errors.push({ prospect_id: p.id, message: orderErr.message });
        continue;
      }

      const order = (orders ?? [])[0] as LeadOrderJoin | undefined;
      if (!order || !order.client_id) {
        // No fulfilled order yet — fulfillment may still be in flight,
        // or the buyer abandoned the intake form. Skip silently; the
        // cron will retry next tick.
        continue;
      }

      // 2b. Most-recent completed scan for this client.
      const { data: scans, error: scanErr } = await supabase
        .from('scans')
        .select('id')
        .eq('client_id', order.client_id)
        .eq('status', 'complete')
        .order('created_at', { ascending: false })
        .limit(1);

      if (scanErr) {
        errors.push({ prospect_id: p.id, message: scanErr.message });
        continue;
      }

      const scan = (scans ?? [])[0] as { id: string } | undefined;
      if (!scan) {
        // No completed scan yet — DataForSEO may still be processing.
        // Skip; the cron retries next tick.
        continue;
      }

      // 2c. Has the buyer already generated an AI insight for this
      //     scan? If yes, they're engaged — no nudge needed.
      const { data: insight } = await supabase
        .from('ai_insights')
        .select('id')
        .eq('scan_id', scan.id)
        .limit(1)
        .maybeSingle<{ id: string }>();

      if (insight) {
        // Engaged — stamp the nudge column anyway so we never
        // re-evaluate this row. Otherwise the cron re-runs these
        // joins on every tick for every already-engaged prospect.
        await supabase
          .from('prospects')
          .update({ ai_coach_nudge_sent_at: new Date().toISOString() })
          .eq('id', p.id)
          .is('ai_coach_nudge_sent_at', null);
        continue;
      }

      // 2d. Resolve the buyer's dashboard URL.
      // For paying clients → /portal/<public_id> (magic-link gated).
      // For cold-outreach leads → /share/<latest active share id>
      // (public, no auth). The old code sent everyone to /portal,
      // which 401'd cold prospects at the agency-portal sign-in page
      // with a misleading "this email is not authorized" error.
      const { data: client } = await supabase
        .from('clients')
        .select('public_id, is_outreach_lead')
        .eq('id', order.client_id)
        .maybeSingle<{ public_id: string; is_outreach_lead: boolean }>();

      if (!client?.public_id) {
        errors.push({
          prospect_id: p.id,
          message: 'client public_id missing',
        });
        continue;
      }

      let dashboardUrl: string;
      if (client.is_outreach_lead) {
        // Look up the freshest non-revoked, non-expired share link.
        // The COLDSCAN flow creates one per outreach lead.
        //
        // If there's no active share link, skip the nudge entirely
        // and stamp ai_coach_nudge_sent_at so the cron doesn't
        // re-evaluate. The old fallback handed cold prospects a
        // /portal/<slug> URL which bounced them at the agency-portal
        // auth wall ("this email is not authorized"). And there's no
        // point sending an AI-Coach nudge to an outreach lead anyway —
        // the coldscan-fulfill route auto-generates the Fix List at
        // scan time, so an engaged cold prospect already saw it on
        // /share/<id>. If they didn't engage AND their share expired,
        // the right re-engagement surface is a manual cold-stage3
        // follow-up, not an automated nudge with a broken URL.
        const { data: scan } = await supabase
          .from('scans')
          .select('id')
          .eq('client_id', order.client_id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle<{ id: string }>();
        let shareUrl: string | null = null;
        if (scan) {
          const { data: share } = await supabase
            .from('scan_share_links')
            .select('id, expires_at')
            .eq('scan_id', scan.id)
            .is('revoked_at', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle<{ id: string; expires_at: string }>();
          if (
            share &&
            new Date(share.expires_at).getTime() >= Date.now()
          ) {
            shareUrl = `${origin}/share/${share.id}#ai-coach`;
          }
        }
        if (!shareUrl) {
          await supabase
            .from('prospects')
            .update({ ai_coach_nudge_sent_at: new Date().toISOString() })
            .eq('id', p.id)
            .is('ai_coach_nudge_sent_at', null);
          continue;
        }
        dashboardUrl = shareUrl;
      } else {
        dashboardUrl = `${portalUrl(origin, client.public_id)}#ai-coach`;
      }

      // 2e. Render + send.
      const html = await render(
        AICoachNudgeEmail({
          firstName: p.first_name,
          businessName: p.business_name,
          dashboardUrl,
        })
      );

      await resend.emails.send({
        from: FROM_ADDRESS,
        to: p.email,
        subject: pickSubject(p.id),
        html,
        // Reply-to Anthony directly — VIP + cold cohorts reply with
        // questions; better they land in the founder inbox than a
        // no-reply void.
        replyTo: 'anthony@fourdots.io',
      });

      // 2f. Stamp idempotency.
      const { error: stampErr } = await supabase
        .from('prospects')
        .update({ ai_coach_nudge_sent_at: new Date().toISOString() })
        .eq('id', p.id)
        .is('ai_coach_nudge_sent_at', null);
      if (stampErr) {
        // Email sent but stamp failed — log loudly. Next cron tick will
        // re-send unless someone fixes the stamp. Acceptable failure
        // mode for a feature designed to nudge engagement.
        console.error(
          '[ai-coach-nudge] stamp failed for',
          p.id,
          stampErr
        );
        errors.push({ prospect_id: p.id, message: stampErr.message });
      }
      sent++;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown error';
      console.error('[ai-coach-nudge] send failed for', p.id, e);
      errors.push({ prospect_id: p.id, message });
    }
  }

  return NextResponse.json({
    scanned: candidates.length,
    sent,
    errors,
  });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
