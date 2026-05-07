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
};

/**
 * Low-level send. Use the higher-level functions below for typed
 * email payloads. Returns true on success, false on any failure
 * (including no-API-key, SDK error, Resend rejection). Never throws.
 */
export async function sendEmail(args: SendArgs): Promise<boolean> {
  const resend = await getResend();
  if (!resend) {
    console.warn(
      `[resend] RESEND_API_KEY not set — skipping send to "${args.to}" (subject: "${args.subject}")`
    );
    return false;
  }

  try {
    const { error } = await resend.emails.send({
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
    });
    if (error) {
      console.error(
        `[resend] send failed to "${args.to}" (subject: "${args.subject}"):`,
        error
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      `[resend] send threw to "${args.to}" (subject: "${args.subject}"):`,
      e instanceof Error ? e.message : String(e)
    );
    return false;
  }
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
}): Promise<boolean> {
  const html = await render(
    OrderConfirmationEmail({
      businessName: args.businessName,
      tier: args.tier,
      dashboardUrl: args.dashboardUrl,
      bookingUrl: args.bookingUrl ?? null,
    })
  );
  return sendEmail({
    to: args.to,
    subject: `Your ${TIER_LABELS_FOR_SUBJECT[args.tier]} is processing — ${args.businessName}`,
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
  return sendEmail({
    to: args.to,
    subject: `Your TurfMap is ready — ${args.businessName}`,
    html,
    attachments: args.pdf
      ? [{ filename: args.pdf.filename, content: args.pdf.content }]
      : undefined,
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
  return sendEmail({
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
  return sendEmail({
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
  return sendEmail({
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
  return sendEmail({
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
  return sendEmail({
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

  return sendEmail({ to: args.to, subject, html, text });
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
  return sendEmail({
    to: args.to,
    subject: `Welcome to TurfMap Pulse+ — finish your setup`,
    html,
  });
}
