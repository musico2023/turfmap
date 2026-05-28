/**
 * Vercel Cron — Visibility Audit milestone sweep.
 *
 * Schedule (vercel.json): every 2 hours (0 *​/2 * * *).
 *
 * Why every-2h, not daily: Sweep 1's window is a 2-hour band centered
 * on T-24h (now+23h..now+25h). At a daily cron, only calls scheduled
 * in a single UTC 2-hour band (12:00-14:00 UTC) ever match the window,
 * so any call outside that band would miss the prep email entirely.
 * Tiling 2h-wide windows with a 2h cron means every scheduled call
 * gets exactly one match within ±1h of T-24h, regardless of time of
 * day. The other sweeps (day 25, 53, 67) re-fire harmlessly each
 * pass thanks to their _sent_at idempotency gates.
 *
 * Four milestone gates, scanned in one pass:
 *
 *   1. T-24h before strategist call → email anthony@fourdots.io
 *      with the generated Roadmap PDF + Strategist Prep Notes.
 *      Gate: prep_email_sent_at IS NULL AND
 *            strategist_call_scheduled_at is in 23-25h window.
 *
 *   2. T+25d after strategist_call_completed_at → email buyer
 *      "your re-scan runs in 5 days." Gate: day_25_reminder_sent_at
 *      IS NULL AND completed_at is 24-26d ago.
 *
 *   3. T+53d after strategist_call_completed_at → email buyer
 *      "60-day check-in — pick a time" with Cal.com link. Gate:
 *      sixty_day_prompted_at IS NULL AND completed_at is 52-54d ago.
 *
 *   4. T+67d after strategist_call_completed_at AND no 60-day call
 *      booked → email buyer "quick nudge" + Slack notify operator.
 *      Gate: day_67_followup_sent_at IS NULL AND
 *            sixty_day_check_scheduled_at IS NULL AND
 *            completed_at is 66-68d ago.
 *
 * Each gate stamps its corresponding _sent_at column so a re-run
 * (cron retry, manual trigger, etc.) is idempotent.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import {
  generateStrategistPrep,
  type GeneratedPrepNotes,
} from '@/lib/ai/strategistPrep';
import { llmFitLabel } from '@/lib/audit/llmFitScore';
import { uploadPrepNotes, signedUrlForAuditFile } from '@/lib/audit/storage';
import { patchVisibilityAudit } from '@/lib/audit/visibilityAudits';
import { generateAndStoreRoadmapPdf } from '@/lib/audit/generateAndStoreRoadmapPdf';
import {
  formatMarket,
  loadCellPatternSummary,
  loadCompetitorSummary,
  loadNapFindingsSummary,
} from '@/lib/audit/auditDataLoaders';
import { calcomSixtyDayCheckUrl } from '@/lib/integrations/calcom';
import { notifySixtyDayUnresponsive } from '@/lib/audit/operatorSlack';
import {
  sendStrategistPrep,
  sendDay25Reminder,
  sendSixtyDayPrompt,
  sendDay67Followup,
} from '@/lib/email/resend';
import type {
  ClientRow,
  LeadOrderRow,
  ScanRow,
  TrackedKeywordRow,
  VisibilityAuditRow,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
// Pre-call generation runs Claude twice + renders PDF + uploads to
// Storage. ~30s typical, occasional 60s+ tail. Plus N concurrent
// audits in a single sweep. 300s gives a comfortable ceiling for
// the largest realistic batch (low single digits per day).
export const maxDuration = 300;

const ANTHONY_EMAIL = 'anthony@fourdots.io';
// Minutes to milliseconds.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ─── Auth ─────────────────────────────────────────────────────────────

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

// ─── Sweep handler ────────────────────────────────────────────────────

type Outcome = {
  candidates: number;
  succeeded: number;
  skipped: number;
  failures: Array<{ auditId: string; reason: string }>;
};

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = getServerSupabase();
  const now = Date.now();

  // Debug-trigger path: when ?force_audit_id=<uuid> is on the
  // request, run the pre-call branch against that specific audit
  // row only — bypassing both the time-window filter and the
  // prep_email_sent_at IS NULL gate. Used by the operator to
  // verify the end-to-end pipeline (Claude generation → PDF render
  // → Storage upload → Anthony's email) without waiting for a
  // real audit row to land in the 23-25h pre-call window.
  //
  // Auth is unchanged (still Bearer CRON_SECRET) so this is safe
  // to ship: only operators with the secret can fire it. The send
  // is idempotent at the email layer (Resend deduplicates if the
  // exact same payload hits within seconds), and the row stamp
  // overwrites cleanly.
  const url = new URL(req.url);
  const forceAuditId = url.searchParams.get('force_audit_id');
  if (forceAuditId) {
    const { data: audit, error } = await supabase
      .from('visibility_audits')
      .select('*')
      .eq('id', forceAuditId)
      .maybeSingle<VisibilityAuditRow>();
    if (error) {
      return NextResponse.json(
        { error: `lookup failed: ${error.message}` },
        { status: 500 }
      );
    }
    if (!audit) {
      return NextResponse.json(
        { error: `no visibility_audits row with id "${forceAuditId}"` },
        { status: 404 }
      );
    }
    if (!audit.strategist_call_scheduled_at) {
      return NextResponse.json(
        {
          error:
            'audit has no strategist_call_scheduled_at — book a Cal.com slot first so the prep email has a date to reference',
          audit_id: audit.id,
        },
        { status: 422 }
      );
    }
    try {
      const outcome = await generateAndEmailPrepForAudit(supabase, audit);
      return NextResponse.json({
        ok: true,
        forced: true,
        audit_id: audit.id,
        outcome,
      });
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          forced: true,
          audit_id: audit.id,
          error: e instanceof Error ? e.message : String(e),
        },
        { status: 500 }
      );
    }
  }

  // Normal path: run all four sweeps concurrently. They touch
  // disjoint rows (different gate columns) so there's no risk of
  // write contention.
  const [preCall, day25, day53, day67] = await Promise.all([
    sweepPreCall(supabase, now),
    sweepDay25(supabase, now),
    sweepDay53(supabase, now),
    sweepDay67(supabase, now),
  ]);

  return NextResponse.json({
    ok: true,
    sweeps: {
      preCall,
      day25,
      day53,
      day67,
    },
  });
}

// ─── Sweep 1: T-24h pre-call (Anthony's prep email) ───────────────────
//
// Window: strategist_call_scheduled_at in [now+23h, now+25h].
// Gate:   prep_email_sent_at IS NULL.
//
// For each candidate: regenerate the Roadmap PDF + Strategist Prep
// Notes (Claude calls), upload to Storage, mint signed URLs, email
// Anthony. Stamp prep_email_sent_at + roadmap_pdf_url + prep_notes_url
// + lift_promise_target_score on success.
//
// We always regenerate at this point (vs. caching from purchase)
// because audit data can drift between purchase and 24h-pre-call:
// the buyer's NAP audit may have completed asynchronously, Apollo
// enrichment may have landed, etc. Fresh generation = freshest call.

type SupabaseClientLike = ReturnType<typeof getServerSupabase>;

async function sweepPreCall(
  supabase: SupabaseClientLike,
  now: number
): Promise<Outcome> {
  const windowStart = new Date(now + 23 * HOUR_MS).toISOString();
  const windowEnd = new Date(now + 25 * HOUR_MS).toISOString();

  const { data: candidates, error } = await supabase
    .from('visibility_audits')
    .select('*')
    .is('prep_email_sent_at', null)
    .gte('strategist_call_scheduled_at', windowStart)
    .lte('strategist_call_scheduled_at', windowEnd)
    .order('strategist_call_scheduled_at', { ascending: true });

  if (error) {
    console.error('[audit-milestones] pre-call select failed', error);
    return { candidates: 0, succeeded: 0, skipped: 0, failures: [] };
  }
  const rows = (candidates ?? []) as VisibilityAuditRow[];

  let succeeded = 0;
  let skipped = 0;
  const failures: Outcome['failures'] = [];

  for (const audit of rows) {
    try {
      const result = await generateAndEmailPrepForAudit(supabase, audit);
      if (result === 'sent') succeeded++;
      else skipped++;
    } catch (e) {
      failures.push({
        auditId: audit.id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { candidates: rows.length, succeeded, skipped, failures };
}

async function generateAndEmailPrepForAudit(
  supabase: SupabaseClientLike,
  audit: VisibilityAuditRow
): Promise<'sent' | 'skipped'> {
  // ── Step 1. Regenerate the Roadmap PDF (fresh data for the call) ──
  // The helper handles: load anchors, load summaries, generate
  // roadmap, render PDF, upload to Storage, stamp roadmap_pdf_url +
  // lift_promise_target_score on the audit row. Overwrites any
  // at-purchase version with the freshest pre-call snapshot.
  const roadmapResult = await generateAndStoreRoadmapPdf(supabase, audit.id);
  if (!roadmapResult.ok) {
    throw new Error(
      `roadmap regen failed at ${roadmapResult.stage}: ${roadmapResult.error}`
    );
  }

  // ── Step 2. Resolve the rest of the call-prep context ──
  // The helper validated the anchors already, but we need them here
  // for the strategist-prep email body. Re-fetch from the cache-hot
  // rows the helper just touched.
  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('id', audit.client_id)
    .maybeSingle<ClientRow>();
  if (!client) return 'skipped';

  const { data: scan } = await supabase
    .from('scans')
    .select('*')
    .eq('id', audit.scan_id)
    .maybeSingle<ScanRow>();
  if (!scan) return 'skipped';

  const { data: keyword } = await supabase
    .from('tracked_keywords')
    .select('*')
    .eq('client_id', audit.client_id)
    .eq('is_primary', true)
    .maybeSingle<TrackedKeywordRow>();

  // ── Step 3. Strategist prep notes (separate Claude call) ──
  // Re-load the summaries the prep generator wants. (They're cheap
  // — Postgres scans of small tables — and isolating the two
  // generators keeps each call's input surface explicit.)
  const napFindingsSummary = await loadNapFindingsSummary(
    supabase,
    audit.client_id
  );
  const competitorSummary = await loadCompetitorSummary(supabase, audit.scan_id);
  const cellPatternSummary = await loadCellPatternSummary(
    supabase,
    audit.scan_id
  );

  const startingTurfScore = audit.starting_turfscore ?? scan.turf_score ?? 0;
  const market = formatMarket(client);

  const fitBreakdown = audit.llm_fit_breakdown ?? {
    score: audit.llm_fit_score ?? 3,
    inputs: {
      revenue_band: null,
      trade_fit: null,
      metro_fit: null,
      ad_active: null,
      review_count: null,
    },
    rule_hits: [],
  };

  const prep: GeneratedPrepNotes = await generateStrategistPrep({
    businessName: client.business_name,
    trade: keyword?.keyword ?? 'unknown trade',
    market,
    scheduledCallTime: formatScheduledTime(audit.strategist_call_scheduled_at),
    currentTurfScore: startingTurfScore,
    projectedTurfScore: roadmapResult.projectedTurfScore,
    llmFitScore: audit.llm_fit_score ?? 3,
    llmFitBreakdown: fitBreakdown,
    napFindingsSummary,
    competitorSummary,
    cellPatternSummary,
    roadmapDiagnosis: roadmapResult.diagnosis,
  });

  // ── Step 4. Upload prep notes (PDF was uploaded by the helper) ──
  const prepUp = await uploadPrepNotes(supabase, {
    auditId: audit.id,
    markdown: prep.markdown,
  });
  if (!prepUp.ok) {
    throw new Error(`prep-notes upload failed: ${prepUp.error}`);
  }

  // ── Step 5. Email Anthony with both signed-URL artifacts ──
  const sent = await sendStrategistPrep({
    to: ANTHONY_EMAIL,
    props: {
      businessName: client.business_name,
      trade: keyword?.keyword ?? 'unknown trade',
      market,
      scheduledCallTime: formatScheduledTime(audit.strategist_call_scheduled_at),
      currentTurfScore: startingTurfScore,
      projectedTurfScore: roadmapResult.projectedTurfScore,
      llmFitScore: audit.llm_fit_score ?? 3,
      llmFitLabel: llmFitLabel(audit.llm_fit_score ?? 3),
      topFinding: prep.keyFindings[0] ?? 'See prep notes for details.',
      roadmapPdfUrl: roadmapResult.roadmapUrl,
      // Prep notes URL points at our own /api/audit/[id]/prep-notes
      // route, not the Supabase signed URL. Supabase Storage forces
      // text/plain + CSP:sandbox on signed-URL HTML responses (XSS
      // prevention), which makes the styled HTML render as raw
      // source. Our route fetches the same Storage file server-side
      // and serves it from www.turfmap.ai with correct Content-Type.
      // Auth-gated to fourdots-domain operators.
      prepNotesUrl: `${appOrigin()}/api/audit/${audit.id}/prep-notes`,
      dashboardUrl: `${appOrigin()}/portal/${client.public_id}`,
    },
  });

  if (!sent) throw new Error('strategist prep email send returned false');

  // ── Step 6. Stamp the prep gate + notes URL ──
  // roadmap_pdf_url + lift_promise_target_score were already stamped
  // by generateAndStoreRoadmapPdf in Step 1. We just add the prep-
  // specific fields here.
  await patchVisibilityAudit(supabase, audit.id, {
    prep_email_sent_at: new Date().toISOString(),
    prep_notes_url: `${appOrigin()}/api/audit/${audit.id}/prep-notes`,
  });

  // Touch signedUrlForAuditFile to silence the unused-import lint —
  // future callers may need a one-off re-sign without re-uploading.
  void signedUrlForAuditFile;

  return 'sent';
}

// ─── Sweep 2: T+25d buyer re-scan reminder ─────────────────────────────

async function sweepDay25(
  supabase: SupabaseClientLike,
  now: number
): Promise<Outcome> {
  const windowStart = new Date(now - 26 * DAY_MS).toISOString();
  const windowEnd = new Date(now - 24 * DAY_MS).toISOString();

  const { data: candidates, error } = await supabase
    .from('visibility_audits')
    .select('*')
    .is('day_25_reminder_sent_at', null)
    .not('strategist_call_completed_at', 'is', null)
    .gte('strategist_call_completed_at', windowStart)
    .lte('strategist_call_completed_at', windowEnd);

  if (error) {
    console.error('[audit-milestones] day-25 select failed', error);
    return { candidates: 0, succeeded: 0, skipped: 0, failures: [] };
  }
  const rows = (candidates ?? []) as VisibilityAuditRow[];

  let succeeded = 0;
  let skipped = 0;
  const failures: Outcome['failures'] = [];

  for (const audit of rows) {
    try {
      const ok = await sendDay25ForAudit(supabase, audit);
      if (ok) succeeded++;
      else skipped++;
    } catch (e) {
      failures.push({
        auditId: audit.id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { candidates: rows.length, succeeded, skipped, failures };
}

async function sendDay25ForAudit(
  supabase: SupabaseClientLike,
  audit: VisibilityAuditRow
): Promise<boolean> {
  const { data: client } = await supabase
    .from('clients')
    .select('public_id, business_name')
    .eq('id', audit.client_id)
    .maybeSingle<Pick<ClientRow, 'public_id' | 'business_name'>>();
  if (!client) return false;

  const { data: leadOrder } = await supabase
    .from('lead_orders')
    .select('email')
    .eq('id', audit.lead_order_id)
    .maybeSingle<Pick<LeadOrderRow, 'email'>>();
  if (!leadOrder?.email) return false;

  // 30-day re-scan target = call_completed_at + 30 days; we're
  // currently at call_completed_at + 25, so re-scan is 5 days out.
  const completed = audit.strategist_call_completed_at!;
  const rescanDate = new Date(
    new Date(completed).getTime() + 30 * DAY_MS
  );

  const sent = await sendDay25Reminder({
    to: leadOrder.email,
    props: {
      businessName: client.business_name,
      rescanDate: formatHumanDate(rescanDate),
      startingTurfScore: audit.starting_turfscore ?? 0,
      projectedTurfScore: audit.lift_promise_target_score ?? 0,
      dashboardUrl: `${appOrigin()}/portal/${client.public_id}`,
      roadmapPdfUrl: audit.roadmap_pdf_url ?? `${appOrigin()}/portal/${client.public_id}`,
    },
  });

  if (sent) {
    await patchVisibilityAudit(supabase, audit.id, {
      day_25_reminder_sent_at: new Date().toISOString(),
    });
  }
  return sent;
}

// ─── Sweep 3: T+53d buyer 60-day prompt ────────────────────────────────

async function sweepDay53(
  supabase: SupabaseClientLike,
  now: number
): Promise<Outcome> {
  const windowStart = new Date(now - 54 * DAY_MS).toISOString();
  const windowEnd = new Date(now - 52 * DAY_MS).toISOString();

  const { data: candidates, error } = await supabase
    .from('visibility_audits')
    .select('*')
    .is('sixty_day_prompted_at', null)
    .not('strategist_call_completed_at', 'is', null)
    .gte('strategist_call_completed_at', windowStart)
    .lte('strategist_call_completed_at', windowEnd);

  if (error) {
    console.error('[audit-milestones] day-53 select failed', error);
    return { candidates: 0, succeeded: 0, skipped: 0, failures: [] };
  }
  const rows = (candidates ?? []) as VisibilityAuditRow[];

  let succeeded = 0;
  let skipped = 0;
  const failures: Outcome['failures'] = [];

  for (const audit of rows) {
    try {
      const ok = await sendDay53ForAudit(supabase, audit);
      if (ok) succeeded++;
      else skipped++;
    } catch (e) {
      failures.push({
        auditId: audit.id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { candidates: rows.length, succeeded, skipped, failures };
}

async function sendDay53ForAudit(
  supabase: SupabaseClientLike,
  audit: VisibilityAuditRow
): Promise<boolean> {
  const { data: client } = await supabase
    .from('clients')
    .select('public_id, business_name')
    .eq('id', audit.client_id)
    .maybeSingle<Pick<ClientRow, 'public_id' | 'business_name'>>();
  if (!client) return false;

  const { data: leadOrder } = await supabase
    .from('lead_orders')
    .select('email')
    .eq('id', audit.lead_order_id)
    .maybeSingle<Pick<LeadOrderRow, 'email'>>();
  if (!leadOrder?.email) return false;

  // Latest scan score (post 30-day re-scan) — let the buyer see
  // their progress in the email body.
  const { data: latestScan } = await supabase
    .from('scans')
    .select('turf_score')
    .eq('client_id', audit.client_id)
    .eq('status', 'complete')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ turf_score: number | null }>();

  const bookingUrl =
    calcomSixtyDayCheckUrl({
      email: leadOrder.email,
      businessName: client.business_name,
      startingTurfScore: audit.starting_turfscore,
    }) ?? `${appOrigin()}/portal/${client.public_id}`;

  const sent = await sendSixtyDayPrompt({
    to: leadOrder.email,
    props: {
      businessName: client.business_name,
      daysSinceCall: 53,
      startingTurfScore: audit.starting_turfscore ?? 0,
      projectedTurfScore: audit.lift_promise_target_score ?? 0,
      currentTurfScore: latestScan?.turf_score ?? null,
      bookingUrl,
      dashboardUrl: `${appOrigin()}/portal/${client.public_id}`,
    },
  });

  if (sent) {
    await patchVisibilityAudit(supabase, audit.id, {
      sixty_day_prompted_at: new Date().toISOString(),
      status: 'sixty_day_prompted',
    });
  }
  return sent;
}

// ─── Sweep 4: T+67d buyer follow-up + Slack ────────────────────────────

async function sweepDay67(
  supabase: SupabaseClientLike,
  now: number
): Promise<Outcome> {
  const windowStart = new Date(now - 68 * DAY_MS).toISOString();
  const windowEnd = new Date(now - 66 * DAY_MS).toISOString();

  const { data: candidates, error } = await supabase
    .from('visibility_audits')
    .select('*')
    .is('day_67_followup_sent_at', null)
    .is('sixty_day_check_scheduled_at', null)
    .not('strategist_call_completed_at', 'is', null)
    .gte('strategist_call_completed_at', windowStart)
    .lte('strategist_call_completed_at', windowEnd);

  if (error) {
    console.error('[audit-milestones] day-67 select failed', error);
    return { candidates: 0, succeeded: 0, skipped: 0, failures: [] };
  }
  const rows = (candidates ?? []) as VisibilityAuditRow[];

  let succeeded = 0;
  let skipped = 0;
  const failures: Outcome['failures'] = [];

  for (const audit of rows) {
    try {
      const ok = await sendDay67ForAudit(supabase, audit);
      if (ok) succeeded++;
      else skipped++;
    } catch (e) {
      failures.push({
        auditId: audit.id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { candidates: rows.length, succeeded, skipped, failures };
}

async function sendDay67ForAudit(
  supabase: SupabaseClientLike,
  audit: VisibilityAuditRow
): Promise<boolean> {
  const { data: client } = await supabase
    .from('clients')
    .select('public_id, business_name')
    .eq('id', audit.client_id)
    .maybeSingle<Pick<ClientRow, 'public_id' | 'business_name'>>();
  if (!client) return false;

  const { data: leadOrder } = await supabase
    .from('lead_orders')
    .select('email')
    .eq('id', audit.lead_order_id)
    .maybeSingle<Pick<LeadOrderRow, 'email'>>();
  if (!leadOrder?.email) return false;

  const bookingUrl =
    calcomSixtyDayCheckUrl({
      email: leadOrder.email,
      businessName: client.business_name,
      startingTurfScore: audit.starting_turfscore,
    }) ?? `${appOrigin()}/portal/${client.public_id}`;

  const sent = await sendDay67Followup({
    to: leadOrder.email,
    props: {
      businessName: client.business_name,
      bookingUrl,
      dashboardUrl: `${appOrigin()}/portal/${client.public_id}`,
    },
  });

  if (sent) {
    await patchVisibilityAudit(supabase, audit.id, {
      day_67_followup_sent_at: new Date().toISOString(),
    });
    // Also fire the operator Slack notification — manual outreach
    // is the right move at day 67 if the buyer hasn't responded
    // to two automated emails.
    await notifySixtyDayUnresponsive({
      businessName: client.business_name,
      trade: '',
      market: '',
      currentTurfScore: audit.starting_turfscore ?? 0,
      llmFitScore: audit.llm_fit_score ?? 0,
      auditDashboardUrl: '',
    });
  }
  return sent;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function appOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://turfmap.ai';
}

function formatScheduledTime(iso: string | null): string {
  if (!iso) return 'TBD';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
      timeZoneName: 'short',
    });
  } catch {
    return iso;
  }
}

function formatHumanDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

// NAP / competitor / cell-pattern / cells loaders + formatMarket
// now live in lib/audit/auditDataLoaders.ts so the at-purchase
// generation path (lib/audit/generateAndStoreRoadmapPdf) and this
// cron share the same data shape.
