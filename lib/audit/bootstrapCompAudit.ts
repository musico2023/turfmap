/**
 * Bootstrap a comp ($0) Visibility Audit for a cold-outreach prospect
 * who booked the audit Cal.com link without going through a paid
 * Stripe purchase.
 *
 * Triggered by:
 *   1. The Cal.com webhook when an audit/strategy BOOKING_CREATED
 *      lands for an email that has NO paid audit lead_order but DOES
 *      have a converted COLDSCAN prospect record.
 *   2. The admin endpoint /api/admin/bootstrap-comp-audit when Anthony
 *      manually bootstraps an audit for a buyer who already booked
 *      before this code shipped (Yohann at Ainger Group Roofing was
 *      the catalyst — booked the audit Cal.com slot without anyone
 *      being notified).
 *
 * Bootstrap fires the same automation a paid $499 audit purchase
 * gets:
 *
 *   - lead_orders row (tier='audit', source='comp_outreach_booking',
 *     stripe_session_id=null, status='fulfilled')
 *   - visibility_audits row tied to the existing COLDSCAN scan
 *     (LLM Fit Score computed inline from primary keyword)
 *   - strategist_call_scheduled_at stamped if a booking timestamp
 *     was supplied
 *   - generateAndStoreRoadmapPdf fires (Claude → Roadmap PDF →
 *     Supabase Storage upload → audit row stamped with
 *     roadmap_pdf_url + lift_promise_target_score)
 *   - sendAuditPurchaseRoadmap email lands in Anthony's inbox with
 *     the PDF attached
 *   - notifyCompAuditBooked Slack ping to #llm-leads
 *
 * Idempotent: if a visibility_audits row already exists for this
 * client, returns it without re-firing. The Cal.com webhook may
 * retry; the admin endpoint may be hit twice; both should be safe.
 */

import { getServerSupabase } from '@/lib/supabase/server';
import { createVisibilityAudit, patchVisibilityAudit } from '@/lib/audit/visibilityAudits';
import { generateAndStoreRoadmapPdf } from '@/lib/audit/generateAndStoreRoadmapPdf';
import { triggerNapAuditAtAuditInit } from '@/lib/audit/triggerNapAuditAtAuditInit';
import { ensurePortalUser } from '@/lib/auth/ensurePortalUser';
import { agencyClientUrl } from '@/lib/urls';
import { sendAuditPurchaseRoadmap } from '@/lib/email/resend';
import { notifyCompAuditBooked } from '@/lib/audit/operatorSlack';
import { computeLlmFitScore } from '@/lib/audit/llmFitScore';
import {
  inferTradeFitFromKeyword,
  previewDiagnosis,
  slugifyBusinessName,
} from '@/lib/audit/tradeClassifier';
import type {
  ClientRow,
  LeadOrderRow,
  ProspectRow,
  ScanRow,
  TrackedKeywordRow,
  VisibilityAuditRow,
} from '@/lib/supabase/types';

export type BootstrapCompAuditInput = {
  /** Either prospect_id OR client_id — whichever the caller has. The
   *  webhook resolves prospect by email first then passes client_id
   *  here; the admin endpoint can accept either. */
  clientId?: string;
  prospectId?: string;
  /** Buyer email — used as a resolution path AND stamped on the
   *  comp lead_orders row so the agency dashboard + Slack ping
   *  surface the actual address the buyer uses (which may differ
   *  from the prospect row's stored email). */
  email?: string | null;
  /** Operator-friendly resolution fallback — when none of the above
   *  match, we fuzzy-match clients.business_name. Useful when the
   *  prospect row was created by a pipeline that didn't capture an
   *  email (some legacy enrichment-only feeds) and the operator
   *  knows the business name but doesn't have UUIDs handy. */
  businessName?: string | null;
  /** Cal.com booking timestamp (ISO). When present, stamps
   *  strategist_call_scheduled_at so the T-24h pre-call cron picks
   *  the row up. Omit when bootstrapping pre-booking. */
  callStartTime?: string | null;
  /** Cal.com booking uid (round-trippable identifier). Stamped on
   *  lead_orders.stripe_metadata.audit_call_uid. */
  callUid?: string | null;
  /** Cal.com manage URL — round-trippable management link for
   *  rescheduling. Stamped on lead_orders.stripe_metadata. */
  bookerUrl?: string | null;
  /** Where the auto-Roadmap email subject/body should report the
   *  operator origin: 'calcom_webhook' (Cal.com pinged us), 'admin'
   *  (Anthony ran the admin endpoint), or 'unknown' (fallback). */
  source: 'calcom_webhook' | 'admin' | 'unknown';
  /** When true: if an existing visibility_audits row is found, RE-RUN
   *  generateAndStoreRoadmapPdf against it so the PDF + operator email
   *  are refreshed with the current template / data. Used by the admin
   *  endpoint when Anthony needs to ship an updated Roadmap (template
   *  copy changed, new competitor data landed, NAP audit just
   *  completed, etc.). Default false — Cal.com webhook retries
   *  should be idempotent. */
  forceRegenerate?: boolean;
};

export type BootstrapCompAuditResult =
  | {
      ok: true;
      /** True when the bootstrap created new rows; false when an
       *  existing visibility_audits row was found and reused. */
      created: boolean;
      auditId: string;
      leadOrderId: string;
      clientId: string;
      /** Signed Supabase Storage URL for the Roadmap PDF when
       *  generation succeeded; null when generation failed (audit
       *  rows + email still attempted). */
      roadmapPdfUrl: string | null;
    }
  | { ok: false; stage: string; error: string };

const OPERATOR_AUDIT_EMAIL = 'anthony@fourdots.io';

export async function bootstrapCompAudit(
  input: BootstrapCompAuditInput,
  appOrigin: string
): Promise<BootstrapCompAuditResult> {
  const supabase = getServerSupabase();

  // ─── 1. Resolve the buyer's client row ─────────────────────────────
  // Multi-strategy resolution. Each strategy is independent; we stop
  // at the first one that returns a client. The history of attempts
  // is reported in the failure error so the operator knows what was
  // tried + which paths were dry.
  //
  // Originally the only fallback was email → prospects.email → coldscan
  // lead_order chain, which broke for Yohann at Ainger Group Roofing
  // because cold-email pipelines that upstreamed his prospect row
  // didn't populate prospects.email (or populated it with a non-
  // matching format). The lead_orders.email column is the canonical
  // contact email — it's what Resend, Cal.com prefills, and the
  // unbooked-nudge crons all use — so going through lead_orders is
  // more robust than going through prospects.
  let client: ClientRow | null = null;
  let prospect: ProspectRow | null = null;
  const trace: string[] = [];

  // ─── Strategy 1: clientId (direct) ────────────────────────────────
  if (input.clientId) {
    const { data } = await supabase
      .from('clients')
      .select('*')
      .eq('id', input.clientId)
      .maybeSingle<ClientRow>();
    client = data ?? null;
    trace.push(`clientId(${input.clientId}) → ${client ? 'hit' : 'miss'}`);
  }

  // ─── Strategy 2: prospectId (direct → client via coldscan order) ──
  if (!client && input.prospectId) {
    const { data: p } = await supabase
      .from('prospects')
      .select('*')
      .eq('id', input.prospectId)
      .maybeSingle<ProspectRow>();
    prospect = p ?? null;
    if (p) {
      const { data: c } = await resolveClientFromProspectId(supabase, p.id);
      client = c;
    }
    trace.push(
      `prospectId(${input.prospectId}) → ${prospect ? 'prospect-hit' : 'prospect-miss'}, ${client ? 'client-hit' : 'client-miss'}`
    );
  }

  // ─── Strategy 3: email → lead_orders.email match ──────────────────
  // lead_orders.email is the canonical contact email — set by the
  // coldscan-fulfill flow + every subsequent purchase. Matching here
  // bypasses the prospect indirection entirely, which is the path
  // that broke for Yohann.
  if (!client && input.email) {
    const normalized = input.email.trim().toLowerCase();
    const { data: leadByEmail } = await supabase
      .from('lead_orders')
      .select('client_id, stripe_metadata')
      .ilike('email', normalized)
      .not('client_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{
        client_id: string;
        stripe_metadata: Record<string, unknown> | null;
      }>();
    if (leadByEmail?.client_id) {
      const { data: c } = await supabase
        .from('clients')
        .select('*')
        .eq('id', leadByEmail.client_id)
        .maybeSingle<ClientRow>();
      client = c ?? null;
      // If the lead_order carries a prospect_id, hydrate the prospect
      // row too — useful for downstream metadata stamping.
      const metaProspectId =
        (leadByEmail.stripe_metadata as Record<string, unknown> | null)?.[
          'prospect_id'
        ];
      if (!prospect && typeof metaProspectId === 'string') {
        const { data: p } = await supabase
          .from('prospects')
          .select('*')
          .eq('id', metaProspectId)
          .maybeSingle<ProspectRow>();
        prospect = p ?? null;
      }
    }
    trace.push(`email→lead_orders(${normalized}) → ${client ? 'hit' : 'miss'}`);
  }

  // ─── Strategy 4: email → prospects.email exact ────────────────────
  // Legacy path retained for cohorts where lead_orders haven't been
  // created yet (replied-but-no-coldscan prospects) but a prospect row
  // exists. Same chain as before: prospect → coldscan order → client.
  if (!client && input.email) {
    const normalized = input.email.trim().toLowerCase();
    const { data: pByEmail } = await supabase
      .from('prospects')
      .select('*')
      .ilike('email', normalized)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<ProspectRow>();
    if (pByEmail) {
      prospect = pByEmail;
      const { data: c } = await resolveClientFromProspectId(
        supabase,
        pByEmail.id
      );
      client = c;
    }
    trace.push(
      `email→prospects.email(${normalized}) → ${pByEmail ? 'prospect-hit' : 'prospect-miss'}, ${client ? 'client-hit' : 'client-miss'}`
    );
  }

  // ─── Strategy 5: email partial (defensive whitespace/format match) ─
  // ILIKE with %word% catches stored-with-whitespace edge cases. We
  // only do this for partial email (everything before the @) so we
  // don't accidentally collapse two distinct people at the same
  // domain.
  if (!client && input.email) {
    const localPart = input.email.split('@')[0]?.trim().toLowerCase();
    const domain = input.email.split('@')[1]?.trim().toLowerCase();
    if (localPart && domain) {
      const { data: pPartial } = await supabase
        .from('prospects')
        .select('*')
        .ilike('email', `%${localPart}%${domain}%`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle<ProspectRow>();
      if (pPartial) {
        prospect = pPartial;
        const { data: c } = await resolveClientFromProspectId(
          supabase,
          pPartial.id
        );
        client = c;
      }
      trace.push(
        `email→prospects.email(ILIKE %${localPart}%${domain}%) → ${pPartial ? 'prospect-hit' : 'prospect-miss'}, ${client ? 'client-hit' : 'client-miss'}`
      );
    }
  }

  // ─── Strategy 6: business_name fuzzy (operator-friendly fallback) ─
  if (!client && input.businessName) {
    const name = input.businessName.trim();
    if (name.length >= 3) {
      const { data: cByName } = await supabase
        .from('clients')
        .select('*')
        .ilike('business_name', `%${name}%`)
        .eq('is_outreach_lead', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle<ClientRow>();
      client = cByName ?? null;
      trace.push(
        `businessName(${name}) → ${client ? 'hit' : 'miss'}`
      );
    }
  }

  if (!client) {
    return {
      ok: false,
      stage: 'resolve-client',
      error: `could not resolve a client row. Attempts: ${trace.join(' | ') || '(no inputs provided)'}`,
    };
  }

  // ─── 2. Find their existing scan (from COLDSCAN) ───────────────────
  const { data: scan } = await supabase
    .from('scans')
    .select('*')
    .eq('client_id', client.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<ScanRow>();
  if (!scan) {
    return {
      ok: false,
      stage: 'resolve-scan',
      error: `client ${client.id} has no scan rows — comp audit requires the COLDSCAN to have run first`,
    };
  }

  const { data: keyword } = await supabase
    .from('tracked_keywords')
    .select('*')
    .eq('client_id', client.id)
    .eq('is_primary', true)
    .maybeSingle<TrackedKeywordRow>();

  // ─── 2a. Ensure buyer has portal access ───────────────────────────
  // Runs BEFORE the existing-audit branching so it provisions on both
  // create AND regenerate paths. Yohann at Ainger Group Roofing was
  // the catalyst: his audit already existed (created by an earlier
  // bootstrap that predated the portal-provisioning wiring), so every
  // subsequent regenerate call hit the existingAudit branch and
  // skipped the provisioning. Result: he held a TurfMap-sent email
  // pointing at /portal/<slug> and got bounced at the login screen
  // because no client_users row existed.
  //
  // Audit buyers paid $499+ and will want ongoing access to their
  // dashboard, Cal.com booking, AI Coach regeneration, etc. Free
  // scan buyers stay on the public /share/<id> URL — we only
  // provision portal accounts at audit-init to keep client_users
  // membership meaningful. Idempotent — safe to call on every
  // bootstrap pass.
  const portalEmail =
    input.email?.trim().toLowerCase() ??
    prospect?.email?.trim().toLowerCase() ??
    null;
  if (portalEmail) {
    const portalResult = await ensurePortalUser(
      supabase,
      client.id,
      portalEmail
    );
    if (!portalResult.ok) {
      // Non-fatal — the audit + PDF still ship. Anthony can manually
      // grant access later via the agency dashboard's ClientUsersManager.
      console.error(
        '[bootstrapCompAudit] ensurePortalUser failed (non-fatal)',
        portalResult.error
      );
    }
  }

  // ─── 3. Idempotency: existing visibility_audits row? ──────────────
  // The unique-on-lead_order_id constraint creates rows 1:1 with
  // lead_orders. Before creating new rows, check whether we've
  // already bootstrapped this buyer.
  const { data: existingAudit } = await supabase
    .from('visibility_audits')
    .select('id, lead_order_id, roadmap_pdf_url')
    .eq('client_id', client.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<
      Pick<VisibilityAuditRow, 'id' | 'lead_order_id' | 'roadmap_pdf_url'>
    >();
  if (existingAudit) {
    // Already bootstrapped. Refresh the booking timestamp if the
    // caller supplied one (e.g. buyer rescheduled).
    if (input.callStartTime) {
      await patchVisibilityAudit(supabase, existingAudit.id, {
        strategist_call_scheduled_at: input.callStartTime,
      });
    }

    // Force-regenerate path — re-run the PDF + operator email
    // pipeline against the existing audit row. Used when the
    // template or upstream data changed since the original
    // bootstrap (Anthony pushed a copy fix, NAP audit just
    // completed, etc.). Skips the lead_order creation step
    // since we already have one.
    if (input.forceRegenerate) {
      return await regenerateForExistingAudit({
        supabase,
        auditId: existingAudit.id,
        leadOrderId: existingAudit.lead_order_id,
        client,
        appOrigin,
        buyerEmail: input.email ?? prospect?.email ?? null,
        prospect,
      });
    }

    return {
      ok: true,
      created: false,
      auditId: existingAudit.id,
      leadOrderId: existingAudit.lead_order_id,
      clientId: client.id,
      roadmapPdfUrl: existingAudit.roadmap_pdf_url,
    };
  }

  // ─── 4. Create the comp audit lead_orders row ─────────────────────
  // No stripe_session_id (this isn't a paid order). The metadata
  // discriminator is source='comp_outreach_booking' so reporting +
  // future "is this a paid audit?" gates can exclude it. The
  // audit_call_status starts at 'booked' (if we have a startTime) or
  // 'unbooked' (if the bootstrap fired pre-booking, e.g. admin
  // endpoint hit before the buyer scheduled).
  const audit_call_status = input.callStartTime ? 'booked' : 'unbooked';
  const buyerEmail =
    input.email ?? prospect?.email ?? null;
  const compMetadata: Record<string, unknown> = {
    source: 'comp_outreach_booking',
    bootstrap_source: input.source,
    audit_call_status,
    audit_call_initiated_at: new Date().toISOString(),
  };
  if (input.callStartTime) {
    compMetadata.audit_call_booked_at = new Date().toISOString();
    compMetadata.audit_call_start_time = input.callStartTime;
  }
  if (input.callUid) compMetadata.audit_call_uid = input.callUid;
  if (input.bookerUrl) compMetadata.audit_call_manage_url = input.bookerUrl;
  if (prospect?.id) compMetadata.prospect_id = prospect.id;

  const { data: leadOrder, error: leadErr } = await supabase
    .from('lead_orders')
    .insert({
      stripe_session_id: null,
      tier: 'audit',
      email: buyerEmail,
      client_id: client.id,
      status: 'fulfilled',
      stripe_metadata: compMetadata,
    })
    .select('*')
    .single<LeadOrderRow>();
  if (leadErr || !leadOrder) {
    return {
      ok: false,
      stage: 'lead-order-insert',
      error: leadErr?.message ?? 'no row returned',
    };
  }

  // ─── 5. Create the visibility_audits row ──────────────────────────
  const tradeFit = inferTradeFitFromKeyword(keyword?.keyword);
  const fitBreakdown = computeLlmFitScore({
    revenueBand: null,
    tradeFit,
    metroFit: null,
    adActive: null,
    reviewCount: null,
  });

  const auditResult = await createVisibilityAudit(supabase, {
    leadOrderId: leadOrder.id,
    scanId: scan.id,
    clientId: client.id,
    startingTurfScore: scan.turf_score ?? 0,
    liftPromiseTargetScore: null,
    llmFitScore: fitBreakdown.score,
    llmFitBreakdown: fitBreakdown,
  });
  if (!auditResult.ok) {
    return {
      ok: false,
      stage: 'visibility-audit-insert',
      error: auditResult.error,
    };
  }
  const auditId = auditResult.row.id;

  // Stamp the scheduled-call timestamp if we have it (so the T-24h
  // cron picks the row up). Status flip from pending_call_schedule
  // happens here for the booked-at-bootstrap path.
  if (input.callStartTime) {
    await patchVisibilityAudit(supabase, auditId, {
      strategist_call_scheduled_at: input.callStartTime,
      status: 'call_scheduled',
    });
  }

  // ─── 5a. Trigger NAP audit at audit-init ──────────────────────────
  // Fire-and-forget — the BL/DFS audit takes ~5-15min to complete +
  // we don't want it blocking the bootstrap response. The
  // triggerNapAuditAtAuditInit helper auto-enriches the location's
  // NAP fields from Google Places when missing (cold-prospect case)
  // BEFORE calling maybeRunNapAudit, so this works even for clients
  // whose COLDSCAN-created location lacks phone + structured address.
  // T-24h cron will regenerate the Roadmap PDF with the populated
  // findings once the audit lands in nap_audits.
  void triggerNapAuditAtAuditInit(supabase, auditId, {
    operatorOrigin: appOrigin,
  }).then((r) => {
    if (!r.ok) {
      console.error(
        '[bootstrapCompAudit] triggerNapAuditAtAuditInit failed',
        r.stage,
        r.error
      );
    }
  });

  // ─── 6. Generate the Roadmap PDF + email Anthony ──────────────────
  // Mirrors the paid-audit fulfill route's after() callback. Fail-soft
  // — we still report success on the bootstrap (the rows are created)
  // even if Claude / PDF / email fail; Anthony can re-trigger
  // generation later via the existing T-24h cron path.
  const pdfResult = await generateAndStoreRoadmapPdf(supabase, auditId);

  let roadmapPdfUrl: string | null = null;
  if (pdfResult.ok) {
    roadmapPdfUrl = pdfResult.roadmapUrl;
    try {
      await sendAuditPurchaseRoadmap({
        to: OPERATOR_AUDIT_EMAIL,
        businessName: client.business_name,
        tierLabel: 'Visibility Audit',
        buyerEmail: buyerEmail ?? '(unknown email)',
        buyerPhone: client.phone ?? null,
        market: [client.city, client.region]
          .filter(Boolean)
          .join(', ') || client.address || '',
        trade: keyword?.keyword ?? prospect?.trade ?? 'unknown',
        startingTurfScore: scan.turf_score ?? 0,
        projectedTurfScore: pdfResult.projectedTurfScore,
        llmFitScore: fitBreakdown.score,
        diagnosisPreview: previewDiagnosis(pdfResult.diagnosis),
        agencyDashboardUrl: agencyClientUrl(appOrigin, client.public_id),
        pdf: {
          filename: `${slugifyBusinessName(client.business_name)}-visibility-roadmap.pdf`,
          content: pdfResult.pdfBuffer,
        },
      });
    } catch (e) {
      console.error(
        '[bootstrapCompAudit] sendAuditPurchaseRoadmap threw',
        e instanceof Error ? e.message : String(e)
      );
    }
  } else {
    console.error(
      '[bootstrapCompAudit] generateAndStoreRoadmapPdf failed',
      pdfResult.stage,
      pdfResult.error
    );
  }

  // ─── 7. Slack ping ────────────────────────────────────────────────
  try {
    await notifyCompAuditBooked({
      businessName: client.business_name,
      buyerEmail: buyerEmail ?? '(unknown email)',
      market: [client.city, client.region]
        .filter(Boolean)
        .join(', ') || client.address || '',
      trade: keyword?.keyword ?? prospect?.trade ?? 'unknown',
      startingTurfScore: scan.turf_score ?? 0,
      llmFitScore: fitBreakdown.score,
      callScheduledAt: input.callStartTime ?? null,
      bootstrapSource: input.source,
      agencyDashboardUrl: agencyClientUrl(appOrigin, client.public_id),
      // Pass the freshly-signed PDF URL through so #llm-leads gets a
      // one-click "Download Roadmap PDF" link in the ping. Null when
      // PDF generation failed (operatorSlack surfaces the failure
      // explicitly so Anthony knows to check Vercel logs).
      roadmapPdfUrl,
    });
  } catch (e) {
    console.error(
      '[bootstrapCompAudit] notifyCompAuditBooked threw',
      e instanceof Error ? e.message : String(e)
    );
  }

  return {
    ok: true,
    created: true,
    auditId,
    leadOrderId: leadOrder.id,
    clientId: client.id,
    roadmapPdfUrl,
  };
}

/** Walk prospect_id → ANY lead_order with this prospect_id → client.
 *  Shared by the prospectId-direct and email→prospects.email
 *  resolution strategies in the multi-path resolver above.
 *
 *  Previously this required `stripe_metadata.source = 'coldscan_free'`,
 *  which only matches lead_orders created by the no-Stripe bypass at
 *  /api/yourmap/coldscan-fulfill. Yohann at Ainger Group Roofing came
 *  through an older Stripe-checkout path (cohort='cold_email',
 *  amount_total=0, source=null) — same prospect_id stamping convention
 *  but no source field. The filter excluded him silently.
 *
 *  The new logic just matches by prospect_id + picks the freshest
 *  lead_order. Any historical or future cold-email path that stamps
 *  prospect_id into metadata works, regardless of how it stamps
 *  source (null, 'coldscan_free', 'cold_email_stripe', whatever).
 */
async function resolveClientFromProspectId(
  supabase: ReturnType<typeof getServerSupabase>,
  prospectId: string
): Promise<{ data: ClientRow | null }> {
  const { data: order } = await supabase
    .from('lead_orders')
    .select('client_id')
    .filter('stripe_metadata->>prospect_id', 'eq', prospectId)
    .not('client_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ client_id: string }>();
  if (!order?.client_id) {
    return { data: null };
  }
  const { data } = await supabase
    .from('clients')
    .select('*')
    .eq('id', order.client_id)
    .maybeSingle<ClientRow>();
  return { data: data ?? null };
}

/** Refresh the PDF + operator email for an audit that already exists.
 *  Called by bootstrapCompAudit when forceRegenerate=true is set.
 *  Re-runs generateAndStoreRoadmapPdf (Claude + PDF + Storage upload),
 *  then re-sends Anthony the operator-facing roadmap email so he gets
 *  the freshest deliverable in his inbox. Doesn't re-fire the Slack
 *  ping — that's a one-time signal per audit, not per regeneration. */
async function regenerateForExistingAudit(args: {
  supabase: ReturnType<typeof getServerSupabase>;
  auditId: string;
  leadOrderId: string;
  client: ClientRow;
  appOrigin: string;
  buyerEmail: string | null;
  prospect: ProspectRow | null;
}): Promise<BootstrapCompAuditResult> {
  const { supabase, auditId, leadOrderId, client, appOrigin, buyerEmail, prospect } = args;

  // Re-trigger the NAP audit AWAITED before PDF generation. The
  // bootstrap's create-path fire-and-forget trigger may have failed
  // silently (e.g. CertaPro 2026-06-08: visibility_audits row created
  // but nap_audits row never landed → PDF rendered "NAP audit data
  // unavailable"). Forcing the regenerate path to AWAIT the audit
  // gives the operator a deterministic recovery: hit regenerate →
  // DFS audit runs (~5-9s for ~9 directories) → PDF reads the now-
  // populated findings. Idempotent on the 30-day window — re-clicks
  // re-use the existing audit row instead of burning DFS credits.
  //
  // maxDuration on the calling endpoint is 300s; DFS overhead is
  // ~5-9s so we have plenty of headroom inside the request budget.
  try {
    const napResult = await triggerNapAuditAtAuditInit(supabase, auditId, {
      operatorOrigin: appOrigin,
    });
    if (!napResult.ok) {
      console.error(
        '[bootstrapCompAudit/regenerate] triggerNapAuditAtAuditInit failed',
        napResult.stage,
        napResult.error
      );
    }
  } catch (e) {
    // Never let a NAP audit failure block the PDF regenerate. The
    // PDF will just render "unavailable" again, same as the
    // original bootstrap — caller gets a regenerate they can retry.
    console.error(
      '[bootstrapCompAudit/regenerate] triggerNapAuditAtAuditInit threw',
      e instanceof Error ? e.message : String(e)
    );
  }

  const pdfResult = await generateAndStoreRoadmapPdf(supabase, auditId);
  if (!pdfResult.ok) {
    return { ok: false, stage: pdfResult.stage, error: pdfResult.error };
  }

  // Look up the LLM Fit Score from the existing audit row so the
  // refreshed email reports the same value the original generation
  // wrote (vs. recomputing from possibly-changed inputs).
  const { data: refreshedAudit } = await supabase
    .from('visibility_audits')
    .select('llm_fit_score, starting_turfscore, lift_promise_target_score')
    .eq('id', auditId)
    .maybeSingle<{
      llm_fit_score: number | null;
      starting_turfscore: number | null;
      lift_promise_target_score: number | null;
    }>();

  // Look up the primary keyword for the operator email body.
  const { data: keyword } = await supabase
    .from('tracked_keywords')
    .select('keyword')
    .eq('client_id', client.id)
    .eq('is_primary', true)
    .maybeSingle<{ keyword: string }>();

  try {
    await sendAuditPurchaseRoadmap({
      to: OPERATOR_AUDIT_EMAIL,
      businessName: client.business_name,
      tierLabel: 'Visibility Audit',
      buyerEmail: buyerEmail ?? '(unknown email)',
      buyerPhone: client.phone ?? null,
      market:
        [client.city, client.region].filter(Boolean).join(', ') ||
        client.address ||
        '',
      trade: keyword?.keyword ?? prospect?.trade ?? 'unknown',
      startingTurfScore: refreshedAudit?.starting_turfscore ?? 0,
      projectedTurfScore:
        refreshedAudit?.lift_promise_target_score ??
        pdfResult.projectedTurfScore,
      llmFitScore: refreshedAudit?.llm_fit_score ?? 3,
      diagnosisPreview: previewDiagnosis(pdfResult.diagnosis),
      agencyDashboardUrl: agencyClientUrl(appOrigin, client.public_id),
      pdf: {
        filename: `${slugifyBusinessName(client.business_name)}-visibility-roadmap.pdf`,
        content: pdfResult.pdfBuffer,
      },
    });
  } catch (e) {
    console.error(
      '[bootstrapCompAudit/regenerate] sendAuditPurchaseRoadmap threw',
      e instanceof Error ? e.message : String(e)
    );
  }

  return {
    ok: true,
    created: false,
    auditId,
    leadOrderId,
    clientId: client.id,
    roadmapPdfUrl: pdfResult.roadmapUrl,
  };
}

