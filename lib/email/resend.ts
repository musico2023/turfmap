/**
 * Shared Resend SDK access + transactional email senders.
 *
 * Templates are now React Email components in components/email/*.
 * Each send* function below renders the relevant component to HTML
 * via @react-email/components' `render()`, then hands the result to
 * the low-level sendEmail() helper. The dark-themed branded shell
 * (TurfMap logo, footer, lime accents) lives in EmailLayout — every
 * template inherits it automatically.
 *
 * Lazy-import + env-var-gated: when RESEND_API_KEY isn't set,
 * sendEmail() returns false instead of throwing. Callers no-op
 * cleanly during local dev without an API key.
 *
 * Required env:
 *   RESEND_API_KEY               — secret, server-side only
 *   RESEND_FROM_EMAIL            — e.g. "TurfMap <noreply@turfmap.ai>"
 *                                  (defaults to that string if unset,
 *                                  but the domain must be verified at
 *                                  resend.com before sends will land)
 *   RESEND_REPLY_TO              — optional; defaults to
 *                                  "support@turfmap.ai" so buyers can
 *                                  hit-reply for support
 */

import type { Resend } from 'resend';
import { render } from '@react-email/components';
import {
  OrderConfirmationEmail,
  type OrderConfirmationEmailProps,
} from '@/components/email/OrderConfirmationEmail';
import {
  ScanReadyEmail,
  type ScanReadyEmailProps,
} from '@/components/email/ScanReadyEmail';
import {
  PortalInviteEmail,
  type PortalInviteEmailProps,
} from '@/components/email/PortalInviteEmail';
import {
  SignInLinkEmail,
  type SignInLinkEmailProps,
} from '@/components/email/SignInLinkEmail';
import {
  DeliveryAlertEmail,
  type DeliveryAlertEmailProps,
} from '@/components/email/DeliveryAlertEmail';
import {
  PulsePlusWelcomeEmail,
  type PulsePlusWelcomeEmailProps,
} from '@/components/email/PulsePlusWelcomeEmail';
import {
  PulseTrialEndingEmail,
  type PulseTrialEndingEmailProps,
} from '@/components/email/PulseTrialEndingEmail';
import {
  AuditCallReminderEmail,
  type AuditCallReminderEmailProps,
} from '@/components/email/AuditCallReminderEmail';
import {
  AuditCallConfirmedEmail,
  type AuditCallConfirmedEmailProps,
} from '@/components/email/AuditCallConfirmedEmail';
import {
  StrategistPrepEmail,
  type StrategistPrepEmailProps,
} from '@/components/email/StrategistPrepEmail';
import {
  Day25ReminderEmail,
  type Day25ReminderEmailProps,
} from '@/components/email/Day25ReminderEmail';
import {
  SixtyDayPromptEmail,
  type SixtyDayPromptEmailProps,
} from '@/components/email/SixtyDayPromptEmail';
import {
  Day67FollowupEmail,
  type Day67FollowupEmailProps,
} from '@/components/email/Day67FollowupEmail';
import {
  StripeSetupLinkEmail,
  type StripeSetupLinkEmailProps,
} from '@/components/email/StripeSetupLinkEmail';
import {
  WeeklyCompetitorSummaryEmail,
  type WeeklyCompetitorSummaryEmailProps,
} from '@/components/email/WeeklyCompetitorSummaryEmail';
import {
  MonthlyPdfEmail,
  type MonthlyPdfEmailProps,
} from '@/components/email/MonthlyPdfEmail';

let cached: Resend | null = null;

const DEFAULT_FROM = 'TurfMap <noreply@turfmap.ai>';
const DEFAULT_REPLY_TO = 'support@turfmap.ai';

/** Returns a singleton Resend instance, or null if RESEND_API_KEY
 *  isn't configured. Senders below already handle null gracefully —
 *  they log a warning and return without throwing. */
export async function getResend(): Promise<Resend | null> {
  if (cached) return cached;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;

  let ResendCtor: typeof import('resend').Resend;
  try {
    ResendCtor = (await import('resend')).Resend;
  } catch {
    return null;
  }

  cached = new ResendCtor(apiKey);
  return cached;
}

/** Resolved sender address — uses RESEND_FROM_EMAIL if set, otherwise
 *  the conservative default. The FROM domain must be verified at
 *  resend.com or the send is silently rejected. */
function fromAddress(): string {
  return process.env.RESEND_FROM_EMAIL || DEFAULT_FROM;
}

function replyToAddress(): string {
  return process.env.RESEND_REPLY_TO || DEFAULT_REPLY_TO;
}

type SendArgs = {
  to: string;
  subject: string;
  html: string;
  /** Optional plain-text fallback. Resend autogenerates from html
   *  if absent, but supplying a hand-written one improves spam-score
   *  + accessibility. */
  text?: string;
  /** PDF or other binary attachments. */
  attachments?: Array<{ filename: string; content: Buffer | string }>;
  /** ISO 8601 timestamp for Resend's scheduled-send. When set, Resend
   *  holds the email in its queue and dispatches at this time instead
   *  of immediately. The returned `id` can be passed to
   *  `cancelScheduledEmail()` to abort delivery before the scheduled
   *  time fires (e.g. when a Cal.com booking lands inside the
   *  audit-call reminder's 20-minute window).
   *
   *  Used in place of a Vercel Cron job for the audit-call-reminder —
   *  Hobby tier caps cron frequency at daily, and Resend's
   *  scheduled-send delivers the same UX without that constraint. */
  scheduledAt?: string;
};

/** Result of a send attempt. `ok` is the success flag the existing
 *  callers already use; `id` is the Resend email ID (used to cancel
 *  scheduled sends — see `cancelScheduledEmail`); `error` carries
 *  Resend's failure reason when `ok` is false (e.g. "address on
 *  suppression list" — useful for admin / diagnostic routes that
 *  need to surface why a send was rejected). */
export type SendResult = {
  ok: boolean;
  id?: string;
  error?: string;
};

/**
 * Low-level send. Use the higher-level functions below for typed
 * email payloads. Returns `{ ok, id? }` — `ok` is false on any
 * failure (no-API-key, SDK error, Resend rejection). Never throws.
 */
export async function sendEmail(args: SendArgs): Promise<SendResult> {
  const resend = await getResend();
  if (!resend) {
    console.warn(
      `[resend] RESEND_API_KEY not set — skipping send to "${args.to}" (subject: "${args.subject}")`
    );
    return { ok: false, error: 'RESEND_API_KEY not set' };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: fromAddress(),
      to: args.to,
      replyTo: replyToAddress(),
      subject: args.subject,
      html: args.html,
      text: args.text,
      attachments: args.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
      })),
      // Resend SDK accepts `scheduledAt` on the same payload — when
      // present, the email is queued instead of sent immediately.
      scheduledAt: args.scheduledAt,
    });
    if (error) {
      console.error(
        `[resend] send failed to "${args.to}" (subject: "${args.subject}"):`,
        error
      );
      // Propagate the Resend error reason to the caller so admin
      // surfaces can surface "name on suppression list" / "invalid
      // recipient" etc. directly instead of forcing a Vercel-logs
      // dive on every failure.
      const errObj = error as { name?: string; message?: string };
      const errMsg =
        errObj.message ?? errObj.name ?? JSON.stringify(error).slice(0, 300);
      return { ok: false, error: errMsg };
    }
    return { ok: true, id: data?.id };
  } catch (e) {
    console.error(
      `[resend] send threw to "${args.to}" (subject: "${args.subject}"):`,
      e instanceof Error ? e.message : String(e)
    );
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Cancel a previously-scheduled email. Used by the Cal.com webhook
 * when a buyer books their strategist call inside the 20-minute
 * audit-reminder window — the scheduled reminder would otherwise
 * fire after the booking was already made, which reads as a bug to
 * the buyer ("you just confirmed; why are you nudging me?").
 *
 * Returns true on successful cancel (or 404 — already-sent /
 * already-cancelled both count as "the reminder won't fire"). False
 * on transport errors so the caller can log + decide whether to
 * retry.
 */
export async function cancelScheduledEmail(id: string): Promise<boolean> {
  const resend = await getResend();
  if (!resend) {
    console.warn(
      `[resend] RESEND_API_KEY not set — cannot cancel scheduled email ${id}`
    );
    return false;
  }
  try {
    const { error } = await resend.emails.cancel(id);
    if (error) {
      // Resend returns a not-found error if the email already sent
      // or was already cancelled. Treat that as success — the goal
      // is "this email won't be delivered" and that's already true.
      const msg = (error as { message?: string }).message ?? String(error);
      if (/not[_ -]?found|404/i.test(msg)) {
        return true;
      }
      console.error(`[resend] cancel failed for ${id}:`, error);
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      `[resend] cancel threw for ${id}:`,
      e instanceof Error ? e.message : String(e)
    );
    return false;
  }
}

/** Boolean-only convenience wrapper around `sendEmail` for callers
 *  that don't care about the email ID. Most templated senders below
 *  use this — the only ones that need the full `{ ok, id }` shape
 *  are scheduled sends (currently just the audit-call reminder). */
async function sendEmailOk(args: SendArgs): Promise<boolean> {
  const r = await sendEmail(args);
  return r.ok;
}

// ─── Templated senders ─────────────────────────────────────────────────────
//
// Each function below builds a typed payload for one transactional
// surface. Renders the matching React Email component into HTML at
// call time (cheap — pure tree-to-string), then dispatches via
// sendEmail. Subject lines stay here so the call site has a single
// source of truth for what the recipient sees in their inbox preview.

const TIER_LABELS_FOR_SUBJECT: Record<
  OrderConfirmationEmailProps['tier'],
  string
> = {
  scan: 'TurfScan',
  audit: 'Visibility Audit',
  strategy: 'Strategy Session',
  pulse: 'TurfMap Pulse',
  pulse_plus: 'TurfMap Pulse+',
};

/**
 * Order confirmation, sent immediately after Stripe checkout completes
 * + the order-fulfill route lands the client + scan rows. Tells the
 * buyer the scan is queued and gives them the dashboard link.
 *
 * For Audit + Strategy tiers, also surfaces a Cal.com booking link
 * for the strategist call that's part of the deliverable. Caller
 * computes the URL via lib/integrations/calcom.
 */
export async function sendOrderConfirmation(args: {
  to: string;
  businessName: string;
  tier: OrderConfirmationEmailProps['tier'];
  dashboardUrl: string;
  /** Cal.com booking link for the strategist call. Set on Audit +
   *  Strategy orders only. NULL when CAL_COM_*_URL env isn't
   *  configured yet — email falls back to "your strategist will
   *  email" copy. */
  bookingUrl?: string | null;
  /** 'upgrade' for the TurfScan→Audit dashboard upsell flow,
   *  'standalone' (default) for direct Stripe-Checkout audit
   *  purchases. Only affects audit-tier headline copy. */
  auditPurchaseKind?: 'standalone' | 'upgrade';
}): Promise<boolean> {
  const html = await render(
    OrderConfirmationEmail({
      businessName: args.businessName,
      tier: args.tier,
      dashboardUrl: args.dashboardUrl,
      bookingUrl: args.bookingUrl ?? null,
      auditPurchaseKind: args.auditPurchaseKind,
    })
  );
  // Audit gets a dedicated subject line ("what happens next") that
  // matches the email's intent — the deliverables list + scheduling
  // section read as a roadmap, not a generic processing receipt.
  // Other tiers keep the "is processing" framing.
  const subject =
    args.tier === 'audit'
      ? `Your TurfMap Visibility Audit — what happens next`
      : `Your ${TIER_LABELS_FOR_SUBJECT[args.tier]} is processing — ${args.businessName}`;
  return sendEmailOk({
    to: args.to,
    subject,
    html,
  });
}

/**
 * Sent after the buyer's first scan (or all scans, for multi-keyword
 * tiers) completes. Includes the dashboard link so they can dive in.
 * If a PDF was generated, attach it.
 */
export async function sendScanReady(args: {
  to: string;
  businessName: string;
  dashboardUrl: string;
  metrics?: ScanReadyEmailProps['metrics'];
  pdf?: { filename: string; content: Buffer };
}): Promise<boolean> {
  const html = await render(
    ScanReadyEmail({
      businessName: args.businessName,
      dashboardUrl: args.dashboardUrl,
      metrics: args.metrics,
      hasPdfAttachment: Boolean(args.pdf),
    })
  );
  return sendEmailOk({
    to: args.to,
    subject: `Your TurfMap is ready — ${args.businessName}`,
    html,
    attachments: args.pdf
      ? [{ filename: args.pdf.filename, content: args.pdf.content }]
      : undefined,
  });
}

/**
 * Audit booking nudge — escalating reminder sequence sent to
 * audit/strategy buyers who haven't booked their Cal.com strategist
 * call. Three stages (day_1, day_3, day_7) fire from the
 * audit-milestones cron, each gated on a dedicated
 * audit_call_nudge_<stage>_sent_at metadata key so they're
 * idempotent. The existing T+20m AuditCallReminder is the first
 * touch; this is the follow-up sequence.
 *
 * The Resend send wraps the React email and dispatches via the
 * shared sendEmailOk helper — same pattern as sendAuditCallReminder
 * + the post-call follow-ups.
 */
export async function sendAuditBookingNudge(args: {
  to: string;
  businessName: string;
  bookingUrl: string;
  stage: 'day_1' | 'day_3' | 'day_7';
}): Promise<boolean> {
  const { AuditBookingNudgeEmail } = await import(
    '@/components/email/AuditBookingNudgeEmail'
  );
  const html = await render(
    AuditBookingNudgeEmail({
      businessName: args.businessName,
      bookingUrl: args.bookingUrl,
      stage: args.stage,
    })
  );
  // Subject mirrors the email's preview text so the buyer's inbox
  // shows a coherent thread regardless of which stage they're on.
  const subjectByStage = {
    day_1: `Quick reminder — your Visibility Audit call for ${args.businessName}`,
    day_3: `Let's get your audit on the calendar — ${args.businessName}`,
    day_7: `Last reminder before I reach out personally — ${args.businessName}`,
  } as const;
  return sendEmailOk({
    to: args.to,
    subject: subjectByStage[args.stage],
    html,
  });
}

/**
 * Audit Purchase Roadmap — sent to anthony@fourdots.io ~30-60s after
 * a Visibility Audit purchase, with the freshly-generated 90-Day
 * Roadmap PDF attached. This is the OPERATOR copy of the deliverable
 * — Anthony reviews it before the strategist call (or before manual
 * outreach when the buyer hasn't booked yet) and sends the PDF to
 * the buyer himself after the call.
 *
 * Distinct from sendStrategistPrep:
 *   - This fires at PURCHASE (no Cal.com call required, no schedule
 *     dependency).
 *   - No Strategist Prep Notes document — that's still generated
 *     fresh at T-24h since it depends on the scheduled call time.
 *
 * The buyer never receives the PDF automatically; auto-emailing the
 * deliverable would land it cold without strategist context. The
 * scan-ready email (sendScanReady) is the only buyer-facing email
 * the audit-tier purchase flow fires.
 */
export async function sendAuditPurchaseRoadmap(args: {
  to: string;
  businessName: string;
  /** Human-readable tier label — "Visibility Audit" or "Strategy
   *  Session". Drives both the inbox subject and the email body
   *  copy so Anthony's inbox is scannable across both tiers. */
  tierLabel: string;
  buyerEmail: string;
  buyerPhone: string | null;
  market: string;
  trade: string;
  startingTurfScore: number;
  projectedTurfScore: number;
  llmFitScore: number;
  diagnosisPreview: string;
  agencyDashboardUrl: string;
  /** PDF buffer + filename. Required — the email IS the wrapper for
   *  this attachment; sending without it defeats the purpose. */
  pdf: { filename: string; content: Buffer };
}): Promise<boolean> {
  const { AuditPurchaseRoadmapEmail } = await import(
    '@/components/email/AuditPurchaseRoadmapEmail'
  );
  const html = await render(
    AuditPurchaseRoadmapEmail({
      businessName: args.businessName,
      tierLabel: args.tierLabel,
      buyerEmail: args.buyerEmail,
      buyerPhone: args.buyerPhone,
      market: args.market,
      trade: args.trade,
      startingTurfScore: args.startingTurfScore,
      projectedTurfScore: args.projectedTurfScore,
      llmFitScore: args.llmFitScore,
      diagnosisPreview: args.diagnosisPreview,
      agencyDashboardUrl: args.agencyDashboardUrl,
    })
  );
  return sendEmailOk({
    to: args.to,
    subject: `New ${args.tierLabel} buyer Roadmap: ${args.businessName}`,
    html,
    attachments: [
      { filename: args.pdf.filename, content: args.pdf.content },
    ],
  });
}

/**
 * Portal-user invite. Sent by the operator when adding a portal user
 * to a client account. The link uses Supabase admin.generateLink so
 * the recipient's browser doesn't need a PKCE verifier (which is what
 * broke the previous in-process auto-invite — see commit ae65cbc).
 */
export async function sendPortalInvite(args: {
  to: string;
  businessName: string;
  /** Supabase magic-link URL from admin.generateLink({ type: 'magiclink' }). */
  magicLinkUrl: string;
}): Promise<boolean> {
  const html = await render(
    PortalInviteEmail({
      businessName: args.businessName,
      magicLinkUrl: args.magicLinkUrl,
    } satisfies PortalInviteEmailProps)
  );
  return sendEmailOk({
    to: args.to,
    subject: `You've been invited to view ${args.businessName}'s TurfMap`,
    html,
  });
}

/**
 * User-initiated sign-in magic link. Sent in response to /login
 * (agency staff) or /portal/<id>/login (portal users) form submits.
 * Replaces the unstyled Supabase-default email that signInWithOtp
 * triggers — uses our React Email branded template instead via
 * admin.generateLink + Resend.
 *
 * Pass `businessName` for portal-flavor copy ("Sign in to <Business>'s
 * dashboard"); omit for the agency variant.
 */
export async function sendSignInLink(args: {
  to: string;
  magicLinkUrl: string;
  businessName?: string | null;
}): Promise<boolean> {
  const html = await render(
    SignInLinkEmail({
      magicLinkUrl: args.magicLinkUrl,
      businessName: args.businessName ?? null,
    } satisfies SignInLinkEmailProps)
  );
  return sendEmailOk({
    to: args.to,
    subject: args.businessName
      ? `Your TurfMap sign-in link — ${args.businessName}`
      : 'Your TurfMap sign-in link',
    html,
  });
}

/**
 * Stripe Checkout setup link, sent when an operator creates a
 * client via the agency-side plan selector with a Pulse / Pulse+
 * plan. The buyer hasn't yet entered payment info; this email
 * carries the Checkout link they click to start their trial /
 * subscription.
 *
 * Sent automatically by /api/clients on row creation when a
 * Checkout link is generated. Re-sent by
 * /api/clients/[id]/regenerate-checkout if the original link
 * expires (24h Stripe default) or the buyer abandons.
 */
export async function sendStripeSetupLink(args: {
  to: string;
  businessName: string;
  tier: 'pulse' | 'pulse_plus';
  trialDays: number;
  checkoutUrl: string;
}): Promise<boolean> {
  const tierLabel = args.tier === 'pulse_plus' ? 'TurfMap Pulse+' : 'TurfMap Pulse';
  const html = await render(
    StripeSetupLinkEmail({
      businessName: args.businessName,
      tier: args.tier,
      trialDays: args.trialDays,
      checkoutUrl: args.checkoutUrl,
    } satisfies StripeSetupLinkEmailProps)
  );
  return sendEmailOk({
    to: args.to,
    subject: `Set up your ${tierLabel} account — ${args.businessName}`,
    html,
  });
}

/**
 * Weekly competitor summary digest — sent Mondays by the
 * weekly-competitor-summary cron to Pulse / Pulse+ buyers who
 * have weekly_competitor_summary_email enabled in their alert prefs.
 */
export async function sendWeeklyCompetitorSummary(args: {
  to: string;
  businessName: string;
  entries: string[];
  exits: string[];
  persistent: string[];
  portalUrl: string;
}): Promise<boolean> {
  const html = await render(
    WeeklyCompetitorSummaryEmail({
      businessName: args.businessName,
      entries: args.entries,
      exits: args.exits,
      persistent: args.persistent,
      portalUrl: args.portalUrl,
    } satisfies WeeklyCompetitorSummaryEmailProps)
  );
  return sendEmailOk({
    to: args.to,
    subject: `Weekly competitor summary — ${args.businessName}`,
    html,
    text:
      `${args.businessName} — last 7 days.\n` +
      `New entrants: ${args.entries.join(', ') || 'none'}\n` +
      `Dropped out: ${args.exits.join(', ') || 'none'}\n` +
      `Holding ground: ${args.persistent.join(', ') || 'none'}\n` +
      args.portalUrl,
  });
}

/**
 * Monthly PDF report email — sent on the 1st of each month by the
 * monthly-pdf cron to Pulse / Pulse+ buyers who have
 * monthly_pdf_email enabled in their alert prefs. PDF buffer is
 * passed in as `attachments` so the buyer gets the file alongside
 * the body copy.
 */
export async function sendMonthlyPdf(args: {
  to: string;
  businessName: string;
  scanDate: string;
  portalUrl: string;
  pdf: { filename: string; content: Buffer };
}): Promise<boolean> {
  const html = await render(
    MonthlyPdfEmail({
      businessName: args.businessName,
      scanDate: args.scanDate,
      portalUrl: args.portalUrl,
    } satisfies MonthlyPdfEmailProps)
  );
  return sendEmailOk({
    to: args.to,
    subject: `Your monthly TurfMap — ${args.businessName}`,
    html,
    text: `Your monthly TurfMap for ${args.businessName} is ready (${args.scanDate}). PDF attached. Dashboard: ${args.portalUrl}`,
    attachments: [{ filename: args.pdf.filename, content: args.pdf.content }],
  });
}

/**
 * Operator-internal scan-delivery alert. Fires from the
 * check-scan-delivery cron when buyers paid in the last 24-25
 * hours but their initial scan hasn't completed — those buyers
 * are inside the 24-hour refund window per the TurfMap terms.
 *
 * Single email per cron run, listing all at-risk clients with
 * deep-links into the agency dashboard. Operator clicks through,
 * fires a manual re-scan from the dashboard.
 *
 * Uses the same EmailLayout shell as buyer-facing emails — single
 * brand, even on internal alerts.
 */
export async function sendDeliveryAlert(args: {
  to: string;
  clients: Array<{
    businessName: string;
    publicId: string;
    hoursSincePurchase: number;
    billingMode: string;
    buyerEmail: string | null;
    dashboardUrl: string;
  }>;
}): Promise<boolean> {
  const html = await render(
    DeliveryAlertEmail({
      clients: args.clients,
    } satisfies DeliveryAlertEmailProps)
  );
  const subject = `[TurfMap ops] ${args.clients.length} client${
    args.clients.length === 1 ? '' : 's'
  } awaiting first scan — refund window`;
  const text =
    `${args.clients.length} TurfMap clients awaiting first scan:\n\n` +
    args.clients
      .map(
        (c) =>
          `- ${c.businessName} (${c.hoursSincePurchase}h since purchase, ${Math.max(
            0,
            24 - c.hoursSincePurchase
          )}h left in refund window)\n  ${c.dashboardUrl}`
      )
      .join('\n');

  return sendEmailOk({ to: args.to, subject, html, text });
}

/**
 * Schedule a payload via Resend's scheduled-send. Internal helper
 * shared by `sendAuditCallReminder` (and any future senders that
 * need to fire delayed). Returns the full `{ ok, id }` so callers
 * can persist the ID for a later cancel.
 *
 * Implementation note: identical to `sendEmail` — only difference
 * is that we expose the ID. Kept as a separate helper to make the
 * intent at call sites obvious ("we want the ID back, not just
 * success/failure").
 */
async function sendEmailWithId(args: SendArgs): Promise<SendResult> {
  return sendEmail(args);
}

/**
 * Pulse+ welcome email — sent after a successful Pulse+ subscription
 * is created. Points the buyer at the dashboard while the operator
 * follows up to gather the categories/hours/photos needed for the
 * citation build.
 */
export async function sendPulsePlusWelcome(args: {
  to: string;
  businessName: string;
  onboardingUrl: string;
}): Promise<boolean> {
  const html = await render(
    PulsePlusWelcomeEmail({
      businessName: args.businessName,
      onboardingUrl: args.onboardingUrl,
    } satisfies PulsePlusWelcomeEmailProps)
  );
  return sendEmailOk({
    to: args.to,
    subject: `Welcome to TurfMap Pulse+ — finish your setup`,
    html,
  });
}

/**
 * Day-28 Pulse trial ending reminder. Triggered by Stripe's
 * customer.subscription.trial_will_end webhook event (fires ~3
 * days before trial end). Surfaces the trial value to date
 * (scan count + current TurfScore) plus both action paths
 * (manage subscription / cancel trial). Doing nothing keeps the
 * subscription — the email is the only "are you sure you want
 * to keep paying?" touch we hit the buyer with.
 */
export async function sendPulseTrialEnding(args: {
  to: string;
  businessName: string;
  scanCount: number;
  currentTurfScore: number | null;
  chargeDate: string;
  manageSubscriptionUrl: string;
  cancelTrialUrl: string;
}): Promise<boolean> {
  const html = await render(
    PulseTrialEndingEmail({
      businessName: args.businessName,
      scanCount: args.scanCount,
      currentTurfScore: args.currentTurfScore,
      chargeDate: args.chargeDate,
      manageSubscriptionUrl: args.manageSubscriptionUrl,
      cancelTrialUrl: args.cancelTrialUrl,
    } satisfies PulseTrialEndingEmailProps)
  );
  return sendEmailOk({
    to: args.to,
    subject: `Your TurfMap Pulse trial ends in 3 days`,
    html,
  });
}

/**
 * Audit-call reminder. Triggered ~20 minutes after a Visibility
 * Audit purchase if the buyer hasn't booked a Cal.com slot yet.
 *
 * Mechanism: Resend scheduled-send. Caller passes `scheduledAt` set
 * to `now() + 20m`. Resend holds the email in its queue and dispatches
 * at that time; we get back an `id` we can later pass to
 * `cancelScheduledEmail()` if the buyer books inside the window
 * (Cal.com webhook fires BOOKING_CREATED → we cancel the queued
 * email so the buyer doesn't get a "you forgot to book" nudge after
 * just confirming their booking).
 *
 * Why scheduled-send instead of a Vercel Cron sweep: Vercel Hobby
 * tier caps cron frequency at daily (any sub-daily schedule like an
 * every-5-minutes cron would deploy-fail on Hobby). Resend's
 * scheduled-send handles the delay without a cron, so this works on
 * any plan and is also more precise (fires exactly at the 20-min
 * mark rather than at the next cron tick).
 *
 * Returns `{ ok, id }` so the caller can persist the ID on
 * `lead_orders.stripe_metadata.audit_reminder_email_id` for the
 * cancel path. If `scheduledAt` is omitted the email sends
 * immediately (used by the legacy cron route as a fallback safety
 * net + by ad-hoc operator triggers).
 */
export async function sendAuditCallReminder(args: {
  to: string;
  businessName: string;
  bookingUrl: string;
  /** ISO 8601 timestamp. When set, Resend schedules the send for
   *  this time; when omitted, sends immediately. */
  scheduledAt?: string;
}): Promise<SendResult> {
  const html = await render(
    AuditCallReminderEmail({
      businessName: args.businessName,
      bookingUrl: args.bookingUrl,
    } satisfies AuditCallReminderEmailProps)
  );
  return sendEmailWithId({
    to: args.to,
    subject: `One more step: book your TurfMap strategist call`,
    html,
    scheduledAt: args.scheduledAt,
  });
}

/**
 * Scan cart-abandonment recovery email. Sent to buyers whose scan-
 * funnel Stripe Checkout session expired unpaid (handled in the
 * `checkout.session.expired` webhook).
 *
 * Three touches off the single expiry event:
 *   - touch_1 sends immediately (scheduledAt omitted)
 *   - touch_2 / touch_3 are queued via Resend scheduled-send by passing
 *     `scheduledAt` = +24h / +72h — same scheduled-send mechanism as
 *     sendAuditCallReminder (no sub-daily Vercel Cron, which Hobby tier
 *     can't run).
 *
 * Returns `{ ok, id }` so the webhook can persist the scheduled touches'
 * Resend IDs on abandoned_checkouts.touch_2_email_id / touch_3_email_id.
 * /api/orders/fulfill cancels those IDs (cancelScheduledEmail) when the
 * buyer recovers, so a buyer who comes back and pays never receives a
 * later nag.
 *
 * Subject mirrors each touch's preview text so the buyer's inbox shows
 * a coherent thread across the sequence.
 */
export async function sendScanRecovery(args: {
  to: string;
  businessName?: string | null;
  keyword?: string | null;
  resumeUrl: string;
  stage: 'touch_1' | 'touch_2' | 'touch_3';
  /** ISO 8601. When set, Resend schedules the send; when omitted, sends
   *  immediately (touch 1). */
  scheduledAt?: string;
}): Promise<SendResult> {
  const { ScanRecoveryEmail } = await import(
    '@/components/email/ScanRecoveryEmail'
  );
  const html = await render(
    ScanRecoveryEmail({
      businessName: args.businessName,
      keyword: args.keyword,
      resumeUrl: args.resumeUrl,
      stage: args.stage,
    })
  );
  const biz = args.businessName?.trim() || 'your business';
  const subjectByStage = {
    touch_1: `You were one step away from your TurfMap — ${biz}`,
    touch_2: `Your competitors are already on the map — ${biz}`,
    touch_3: `Last reminder about your TurfScan — ${biz}`,
  } as const;
  return sendEmailWithId({
    to: args.to,
    subject: subjectByStage[args.stage],
    html,
    scheduledAt: args.scheduledAt,
  });
}

/**
 * sendScoreUnlockNudge — 3-touch drip for /score lead-magnet
 * visitors who got a free TurfScore but haven't paid $99 to unlock.
 *
 * Touch 1 sends immediately from /api/score/preview-init; touches
 * 2 and 3 are queued via Resend scheduled-send (24h and 72h after
 * preview). Returns SendResult.id so the caller can store it on
 * lead_orders.stripe_metadata for later cancellation when the
 * buyer unlocks (handleScoreUnlockCompletion reads the ids back
 * + calls cancelScheduledEmail).
 *
 * Mirrors sendScanRecovery's signature so the call sites are
 * symmetric across the two abandonment funnels (cart-abandonment
 * for paid-checkout abandoners; score-unlock for preview-stage
 * abandoners). Same EmailLayout shell + visual rhythm across
 * touches so the buyer's inbox feels consistent.
 */
export async function sendScoreUnlockNudge(args: {
  to: string;
  businessName?: string | null;
  keyword?: string | null;
  turfScore?: number | null;
  turfBand?: string | null;
  previewUrl: string;
  stage: 'touch_1' | 'touch_2' | 'touch_3';
  /** ISO 8601. When set, Resend schedules the send; when omitted,
   *  sends immediately (touch 1). */
  scheduledAt?: string;
  /** Lander slug forwarded into the email template so price strings
   *  match what unlock-init will actually charge (Meta cohorts see
   *  $49 + MAPCHECK50; everyone else sees $99 list). */
  leadSource?: string | null;
}): Promise<SendResult> {
  const { ScoreUnlockNudgeEmail } = await import(
    '@/components/email/ScoreUnlockNudgeEmail'
  );
  const html = await render(
    ScoreUnlockNudgeEmail({
      businessName: args.businessName,
      keyword: args.keyword,
      turfScore: args.turfScore,
      turfBand: args.turfBand,
      previewUrl: args.previewUrl,
      stage: args.stage,
      leadSource: args.leadSource,
    })
  );
  const biz = args.businessName?.trim() || 'your business';
  const scoreFragment =
    typeof args.turfScore === 'number' && Number.isFinite(args.turfScore)
      ? ` is ${Math.round(args.turfScore)}/100`
      : ' is ready';
  // Subjects re-tuned post-re-gate (the /share preview now masks
  // competitor names — they're the unlock payoff, not a free reveal).
  // Touch 2's subject leads on the identity curiosity hook; touch 3
  // calls back to the same masked rows one last time. Touch 1 stays
  // score-led since the buyer hasn't yet seen the masked-name UI at
  // the moment touch 1 hits the inbox (it fires immediately on
  // preview-init, before they navigate to /share).
  const subjectByStage = {
    touch_1: `Your TurfScore${scoreFragment} — ${biz}`,
    touch_2: `Find out who's outranking you — ${biz}`,
    touch_3: `Last call to find out who's outranking you — ${biz}`,
  } as const;
  return sendEmailWithId({
    to: args.to,
    subject: subjectByStage[args.stage],
    html,
    scheduledAt: args.scheduledAt,
  });
}

/**
 * Strategist Prep email — to anthony@fourdots.io, 24h pre-call.
 * Carries signed URLs for the Roadmap PDF + Strategist Prep Notes
 * (markdown), plus an inline at-a-glance summary so Anthony can
 * scan the subject line + body and walk into the call already
 * loaded with the diagnosis + LLM Fit Score.
 *
 * The destination is the operator's email, not the buyer's. Phase
 * 3 cron sends to anthony@fourdots.io specifically; we don't pass
 * `to` because the destination is constant for this template.
 */
export async function sendStrategistPrep(args: {
  /** Operator email — defaults to anthony@fourdots.io but accepts
   *  override for testing. */
  to: string;
  props: StrategistPrepEmailProps;
}): Promise<boolean> {
  const html = await render(StrategistPrepEmail(args.props));
  const subject = `Tomorrow's audit call: ${args.props.businessName} (${args.props.trade}, ${args.props.market}) — TurfScore ${args.props.currentTurfScore}, LLM Fit ${args.props.llmFitScore}/5`;
  return sendEmailOk({
    to: args.to,
    subject,
    html,
  });
}

/** Day-25 buyer re-scan reminder — 5 days before the 30-day re-scan. */
export async function sendDay25Reminder(args: {
  to: string;
  props: Day25ReminderEmailProps;
}): Promise<boolean> {
  const html = await render(Day25ReminderEmail(args.props));
  return sendEmailOk({
    to: args.to,
    subject: `Your TurfMap re-scan runs in 5 days — ${args.props.businessName}`,
    html,
  });
}

/** Day-53 buyer 60-day check-in prompt. Includes Cal.com link. */
export async function sendSixtyDayPrompt(args: {
  to: string;
  props: SixtyDayPromptEmailProps;
}): Promise<boolean> {
  const html = await render(SixtyDayPromptEmail(args.props));
  return sendEmailOk({
    to: args.to,
    subject: `Your TurfMap 60-day check-in — pick a time`,
    html,
  });
}

/** Day-67 buyer follow-up — fires only when 60-day check-in is
 *  still unscheduled at day 67. Slack mirrors this to #llm-leads. */
export async function sendDay67Followup(args: {
  to: string;
  props: Day67FollowupEmailProps;
}): Promise<boolean> {
  const html = await render(Day67FollowupEmail(args.props));
  return sendEmailOk({
    to: args.to,
    subject: `Quick nudge on your 60-day check-in — ${args.props.businessName}`,
    html,
  });
}

/**
 * Audit-call booking confirmation. Fires from the Cal.com webhook
 * when BOOKING_CREATED lands. The webhook handler computes the
 * pre-formatted scheduledAt + manageBookingUrl from Cal.com's
 * payload, and we own the email shell here so the buyer sees a
 * branded follow-up alongside Cal.com's auto-generated calendar
 * invite (Cal.com still sends its own — this is the TurfMap-side
 * confirmation, not a replacement).
 */
export async function sendAuditCallConfirmed(args: {
  to: string;
  businessName: string;
  scheduledAt: string;
  manageBookingUrl: string;
  dashboardUrl: string;
}): Promise<boolean> {
  const html = await render(
    AuditCallConfirmedEmail({
      businessName: args.businessName,
      scheduledAt: args.scheduledAt,
      manageBookingUrl: args.manageBookingUrl,
      dashboardUrl: args.dashboardUrl,
    } satisfies AuditCallConfirmedEmailProps)
  );
  return sendEmailOk({
    to: args.to,
    subject: `Strategist call confirmed for ${args.scheduledAt}`,
    html,
  });
}

/**
 * sendAuditUpgradeRecovery — 3-touch drip for score_unlock buyers
 * who skipped the audit upgrade on /order/success.
 *
 * All three touches use Resend scheduled-send. Returns SendResult.id
 * so the caller can store it on lead_orders.stripe_metadata for
 * later cancellation (handleAuditUpgradeCompletion reads the ids
 * back + calls cancelScheduledEmail when the buyer converts).
 *
 * Times itself within the audit window's natural 24h scarcity —
 * T+1h, T+8h, T+22h — so every touch carries an honest countdown
 * to the cutoff. Touch 3 should also pass cutoffTimeLabel so the
 * "expires at 3:42 PM EDT today" copy renders cleanly.
 */
export async function sendAuditUpgradeRecovery(args: {
  to: string;
  businessName?: string | null;
  turfScore?: number | null;
  reopenUrl: string;
  stage: 'touch_1' | 'touch_2' | 'touch_3';
  /** Hours remaining until the 24h audit window closes at compose
   *  time. Baked into the body copy. */
  hoursRemaining: number;
  /** Touch 3 only. Pre-formatted local-time string. */
  cutoffTimeLabel?: string | null;
  /** ISO 8601. Always set for this drip — even touch 1 is scheduled
   *  for T+1h rather than sent immediately, so the buyer doesn't get
   *  the recovery email while they're still actively on /order/success. */
  scheduledAt?: string;
}): Promise<SendResult> {
  const { AuditUpgradeRecoveryEmail } = await import(
    '@/components/email/AuditUpgradeRecoveryEmail'
  );
  const html = await render(
    AuditUpgradeRecoveryEmail({
      businessName: args.businessName,
      turfScore: args.turfScore,
      reopenUrl: args.reopenUrl,
      stage: args.stage,
      hoursRemaining: args.hoursRemaining,
      cutoffTimeLabel: args.cutoffTimeLabel,
    })
  );
  const biz = args.businessName?.trim() || 'your business';
  const safeHours = Math.max(1, Math.round(args.hoursRemaining));
  // Subjects lead on the $302 discount + remaining hours so the
  // urgency lands in the inbox preview without the buyer opening.
  const subjectByStage = {
    touch_1: `Your audit upgrade is still here — save $302 (${biz})`,
    touch_2: `${safeHours} hours left to save $302 on your audit`,
    touch_3: `Final ${safeHours}h: $302 audit discount expires`,
  } as const;
  return sendEmailWithId({
    to: args.to,
    subject: subjectByStage[args.stage],
    html,
    scheduledAt: args.scheduledAt,
  });
}

/**
 * sendPulseRecovery — 2-touch drip for score_unlock buyers who
 * didn't activate the free Pulse trial on /order/success.
 *
 * Limited-time offer: an extended 60-day free trial (vs the
 * standard 30 days) for buyers who activate via this recovery
 * email's deep link within 72 hours of unlock. The Pulse-attach
 * Checkout route reads ?extended=1 off the reopen URL and applies
 * trial_period_days: 60 in the Stripe session.
 *
 * Cancelled via cancelScheduledEmail when the Pulse trial subscription
 * is created (Stripe customer.subscription.created webhook).
 */
export async function sendPulseRecovery(args: {
  to: string;
  businessName?: string | null;
  reopenUrl: string;
  stage: 'touch_1' | 'touch_2';
  /** Hours remaining until the 72h extended-trial offer expires at
   *  compose time. Baked into the body copy. */
  hoursRemaining: number;
  /** ISO 8601. T+48h for touch 1, T+5d (~120h) for touch 2. */
  scheduledAt?: string;
}): Promise<SendResult> {
  const { PulseRecoveryEmail } = await import(
    '@/components/email/PulseRecoveryEmail'
  );
  const html = await render(
    PulseRecoveryEmail({
      businessName: args.businessName,
      reopenUrl: args.reopenUrl,
      stage: args.stage,
      hoursRemaining: args.hoursRemaining,
    })
  );
  const biz = args.businessName?.trim() || 'your business';
  const safeHours = Math.max(1, Math.round(args.hoursRemaining));
  const subjectByStage = {
    touch_1: `60-day Pulse trial (vs the standard 30) — ${biz}`,
    touch_2: `Final ${safeHours}h: your 60-day Pulse trial expires`,
  } as const;
  return sendEmailWithId({
    to: args.to,
    subject: subjectByStage[args.stage],
    html,
    scheduledAt: args.scheduledAt,
  });
}
