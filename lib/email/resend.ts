/**
 * Shared Resend SDK access + transactional email senders.
 *
 * Mirrors the lib/stripe/client.ts pattern: lazy import, env-var-gated,
 * graceful degradation when RESEND_API_KEY isn't set (returns null
 * instead of throwing so callers can no-op cleanly during local dev
 * without an API key).
 *
 * Every email sender in this module is fire-and-forget from the
 * caller's perspective — failures are logged but never propagated up.
 * The user-facing flow (order fulfillment, magic-link delivery, etc.)
 * is the source of truth for whether the side-effect that triggered
 * the email succeeded; email delivery is downstream.
 *
 * Required env:
 *   RESEND_API_KEY               — secret, server-side only
 *   RESEND_FROM_EMAIL            — e.g. "TurfMap <noreply@turfmap.ai>"
 *                                  (defaults to that string if unset,
 *                                  but the domain must be verified at
 *                                  resend.com before sends will land)
 *   RESEND_REPLY_TO              — optional; defaults to
 *                                  "anthony@fourdots.io" so buyers can
 *                                  hit-reply for support
 */

import type { Resend } from 'resend';

let cached: Resend | null = null;

const DEFAULT_FROM = 'TurfMap <noreply@turfmap.ai>';
const DEFAULT_REPLY_TO = 'anthony@fourdots.io';

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
// surface. Keep these inline for now — small enough that React Email
// templates would be over-engineering. If the volume of emails grows
// past ~6 distinct surfaces, migrate to @react-email/components and
// store templates in components/email/. For now: simple HTML strings.

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
  tier: 'scan' | 'audit' | 'strategy' | 'pulse' | 'pulse_plus';
  dashboardUrl: string;
  /** Cal.com booking link for the strategist call. Set on Audit +
   *  Strategy orders only. NULL when CAL_COM_*_URL env isn't
   *  configured yet — email falls back to "we'll be in touch"
   *  language so it doesn't reference a missing link. */
  bookingUrl?: string | null;
}): Promise<boolean> {
  const tierLabel = {
    scan: 'TurfScan',
    audit: 'Visibility Audit',
    strategy: 'Strategy Session',
    pulse: 'TurfMap Pulse',
    pulse_plus: 'TurfMap Pulse+',
  }[args.tier];

  const callLabel =
    args.tier === 'strategy' ? '90-minute strategy session' : '30-minute walkthrough';
  const includesCall = args.tier === 'audit' || args.tier === 'strategy';

  const bookingBlock = includesCall
    ? args.bookingUrl
      ? `
        <div style="margin:24px 0;padding:16px;border:1px solid #27272a;border-radius:8px;background:#111;">
          <p style="margin:0 0 8px;font-weight:600;color:#ededed;">
            Book your ${callLabel}
          </p>
          <p style="margin:0 0 14px;font-size:14px;color:#a1a1aa;">
            Pick a time that works — we've pre-filled your email so it's
            one click.
          </p>
          ${cta(args.bookingUrl, 'Book my call →')}
        </div>
      `
      : `
        <p style="font-size:13px;color:#a1a1aa;">
          Your strategist will reach out within 2 business days to schedule
          your ${callLabel}.
        </p>
      `
    : '';

  return sendEmail({
    to: args.to,
    subject: `Your TurfMap ${tierLabel} is processing — ${args.businessName}`,
    html: htmlShell(`
      <h1 style="font-size:22px;color:#ededed;margin:0 0 12px;">
        Your ${tierLabel} is on the way.
      </h1>
      <p>
        We're scanning <strong>${escape(args.businessName)}</strong>'s territory
        right now. The first scan typically lands in 30–60 seconds; you'll
        get another email when your dashboard is ready.
      </p>
      <p>
        In the meantime, you can bookmark your dashboard:
      </p>
      <p style="margin:24px 0;">
        ${cta(args.dashboardUrl, 'Open my dashboard →')}
      </p>
      ${bookingBlock}
      <p style="font-size:13px;color:#71717a;">
        Questions? Just hit reply — this address is monitored.
      </p>
    `),
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
  pdf?: { filename: string; content: Buffer };
}): Promise<boolean> {
  return sendEmail({
    to: args.to,
    subject: `Your TurfMap is ready — ${args.businessName}`,
    html: htmlShell(`
      <h1 style="font-size:22px;color:#ededed;margin:0 0 12px;">
        Your map's ready.
      </h1>
      <p>
        We finished the 81-point geo-grid scan for
        <strong>${escape(args.businessName)}</strong>. Open your dashboard to
        see the heatmap, your TurfScore, and the AI Coach playbook.
      </p>
      <p style="margin:24px 0;">
        ${cta(args.dashboardUrl, 'View my TurfMap →')}
      </p>
      ${args.pdf ? `<p style="font-size:13px;color:#a1a1aa;">Your PDF report is attached.</p>` : ''}
    `),
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
  return sendEmail({
    to: args.to,
    subject: `You've been invited to view ${args.businessName}'s TurfMap`,
    html: htmlShell(`
      <h1 style="font-size:22px;color:#ededed;margin:0 0 12px;">
        You're invited.
      </h1>
      <p>
        <strong>${escape(args.businessName)}</strong> has shared their
        local-visibility dashboard with you. Click the button below to
        sign in — no password needed.
      </p>
      <p style="margin:24px 0;">
        ${cta(args.magicLinkUrl, 'Open my dashboard →')}
      </p>
      <p style="font-size:13px;color:#71717a;">
        This link expires in 24 hours. If it stops working, ask
        ${escape(args.businessName)}'s account manager for a fresh one.
      </p>
    `),
  });
}

/**
 * Pulse+ welcome email — sent after a successful Pulse+ subscription
 * is created. Points the buyer at the onboarding form (more NAP
 * fields, business hours, photos) needed for the BrightLocal
 * Citation Builder integration. Without those fields, citations
 * can't be submitted, so this email is operationally important —
 * not just a nice-to-have.
 */
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
  const trialLine =
    args.trialDays > 0
      ? `Your ${args.trialDays}-day trial starts as soon as you complete checkout. We don't charge anything until day ${args.trialDays + 1} — cancel any time before then with no fees.`
      : `Checkout will start your subscription immediately. You can cancel any time from your dashboard.`;
  return sendEmail({
    to: args.to,
    subject: `Set up your ${tierLabel} account — ${args.businessName}`,
    html: htmlShell(`
      <h1 style="font-size:22px;color:#ededed;margin:0 0 12px;">
        Set up your ${tierLabel} account.
      </h1>
      <p>
        Your account for <strong>${escape(args.businessName)}</strong> is
        provisioned and ready. Click the button below to complete
        payment setup with Stripe — same checkout process you'd see
        on any modern subscription product.
      </p>
      <p style="margin:24px 0;">
        ${cta(args.checkoutUrl, 'Complete payment setup →')}
      </p>
      <p style="font-size:13px;color:#a1a1aa;">
        ${trialLine}
      </p>
      <p style="font-size:13px;color:#71717a;">
        The link expires in 24 hours — if it stops working, hit
        reply and we'll send a fresh one.
      </p>
    `),
  });
}

export async function sendPulsePlusWelcome(args: {
  to: string;
  businessName: string;
  onboardingUrl: string;
}): Promise<boolean> {
  return sendEmail({
    to: args.to,
    subject: `Welcome to TurfMap Pulse+ — finish your setup`,
    html: htmlShell(`
      <h1 style="font-size:22px;color:#ededed;margin:0 0 12px;">
        Welcome to Pulse+.
      </h1>
      <p>
        Pulse+ tracks your visibility weekly and builds + maintains your
        citations across ~25 industry directories. Before we kick off
        the citation build for <strong>${escape(args.businessName)}</strong>,
        we need a few extra details — categories, hours, photos.
      </p>
      <p style="margin:24px 0;">
        ${cta(args.onboardingUrl, 'Finish my setup →')}
      </p>
      <p style="font-size:13px;color:#a1a1aa;">
        First wave of citations goes live within 2 weeks of completing
        this form. Full propagation takes 6–8 weeks.
      </p>
    `),
  });
}

// ─── Tiny HTML helpers ─────────────────────────────────────────────────────

/** Wrap body content in the standard TurfMap-branded shell. Inline
 *  styles only (Gmail strips <style> tags), dark theme, lime accents. */
function htmlShell(body: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#0a0a0a;color:#e4e4e7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#0d0d0d;border:1px solid #27272a;border-radius:8px;padding:28px;">
        <tr><td>
          <div style="margin-bottom:24px;">
            <span style="display:inline-block;padding:6px 10px;background:#c5ff3a;color:#000;font-weight:700;border-radius:4px;font-size:13px;letter-spacing:0.04em;">TurfMap</span>
          </div>
          ${body}
          <hr style="border:0;border-top:1px solid #27272a;margin:28px 0 16px;"/>
          <p style="font-size:12px;color:#52525b;line-height:1.5;margin:0;">
            TurfMap.ai · An 81-point geo-grid SEO diagnostic for local businesses.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** Lime-accent CTA button, inline-styled for email-client compat. */
function cta(href: string, label: string): string {
  return `<a href="${escapeAttr(href)}" style="display:inline-block;padding:12px 20px;background:#c5ff3a;color:#000;font-weight:700;text-decoration:none;border-radius:6px;font-size:15px;">${escape(label)}</a>`;
}

/** Escape user-controlled strings interpolated into HTML body text. */
function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape strings interpolated into HTML attribute values. */
function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/&/g, '&amp;');
}
