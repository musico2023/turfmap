/**
 * Alert dispatch — render typed AlertEvents into email + Slack
 * payloads and deliver them.
 *
 * Email goes via the Resend wrapper (lib/email/resend.ts). Slack goes
 * via incoming-webhook POST to the URL the operator pasted in
 * settings. Each delivery is fire-and-error-swallow — failures log
 * but don't propagate up. The post-scan path that calls dispatch()
 * shouldn't fail a scan because an email bounce.
 *
 * Each AlertEvent renders into both a subject line and a body,
 * shaped slightly differently for email (HTML, branded shell) and
 * Slack (mrkdwn, single-block message). One sender per alert keeps
 * the formatting decisions adjacent to the data.
 */

import { sendEmail } from '@/lib/email/resend';
import type { AlertEvent } from './diff';

export type DispatchTarget = {
  /** Recipients for email alerts. Caller passes the agency owner +
   *  any client_users that should receive. Empty = no email send. */
  emailRecipients: string[];
  /** Slack incoming-webhook URL. Null = no Slack send. */
  slackWebhookUrl: string | null;
  /** Client business name + dashboard URL — used to brand the
   *  message body and link the recipient back into the product. */
  businessName: string;
  dashboardUrl: string;
};

export type DispatchResult = {
  type: AlertEvent['type'];
  emailsSent: number;
  emailErrors: number;
  slackSent: boolean;
  slackError: string | null;
};

/**
 * Dispatch a single alert event. Sends one email per recipient (so
 * each lands cleanly in their inbox; "to: a, b, c" tends to read as
 * a group thread some mail clients dedupe), plus one Slack message.
 */
export async function dispatchAlert(
  event: AlertEvent,
  target: DispatchTarget
): Promise<DispatchResult> {
  const { subject, html, text, slackText } = renderAlert(event, target);

  // Email fan-out (one send per recipient). Sequential rather than
  // Promise.all to stay polite to Resend's per-second rate limits.
  let emailsSent = 0;
  let emailErrors = 0;
  for (const to of target.emailRecipients) {
    const ok = await sendEmail({ to, subject, html, text });
    if (ok) emailsSent += 1;
    else emailErrors += 1;
  }

  let slackSent = false;
  let slackError: string | null = null;
  if (target.slackWebhookUrl) {
    try {
      const res = await fetch(target.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: slackText }),
      });
      if (res.ok) {
        slackSent = true;
      } else {
        slackError = `slack ${res.status}: ${(await res.text()).slice(0, 200)}`;
        console.error(`[alerts/dispatch] ${slackError}`);
      }
    } catch (e) {
      slackError = e instanceof Error ? e.message : String(e);
      console.error(`[alerts/dispatch] slack threw: ${slackError}`);
    }
  }

  return {
    type: event.type,
    emailsSent,
    emailErrors,
    slackSent,
    slackError,
  };
}

// ─── rendering ─────────────────────────────────────────────────────────────

type Rendered = {
  subject: string;
  html: string;
  text: string;
  slackText: string;
};

function renderAlert(event: AlertEvent, target: DispatchTarget): Rendered {
  const biz = escapeHtml(target.businessName);
  switch (event.type) {
    case 'score_movement': {
      const arrow = event.direction === 'up' ? '↑' : '↓';
      const sign = event.delta > 0 ? '+' : '';
      const subject = `${arrow} TurfScore ${sign}${event.delta} — ${target.businessName}`;
      const headline =
        event.direction === 'up'
          ? `Your TurfScore moved up by ${event.delta} points.`
          : `Your TurfScore dropped by ${Math.abs(event.delta)} points.`;
      return {
        subject,
        html: emailShell(`
          <h1 style="font-size:22px;color:#ededed;margin:0 0 12px;">${headline}</h1>
          <p>
            <strong>${biz}</strong> moved from
            <span style="color:#a1a1aa;">${event.priorScore}</span> to
            <strong style="color:${event.direction === 'up' ? '#c5ff3a' : '#ff9f3a'};">${event.newScore}</strong>.
          </p>
          <p style="margin:24px 0;">
            ${ctaButton(target.dashboardUrl, 'Open dashboard →')}
          </p>
        `),
        text: `${headline}\n${target.businessName} moved from ${event.priorScore} to ${event.newScore}.\n\n${target.dashboardUrl}`,
        slackText: `${arrow} *TurfScore ${sign}${event.delta}* for *${target.businessName}* — ${event.priorScore} → ${event.newScore}. <${target.dashboardUrl}|Open dashboard>`,
      };
    }
    case 'competitor_entries': {
      const list = event.newCompetitors.slice(0, 5);
      const more =
        event.newCompetitors.length > 5
          ? ` (+${event.newCompetitors.length - 5} more)`
          : '';
      const subject = `New competitor${list.length === 1 ? '' : 's'} in your 3-pack — ${target.businessName}`;
      return {
        subject,
        html: emailShell(`
          <h1 style="font-size:22px;color:#ededed;margin:0 0 12px;">
            ${list.length === 1 ? 'New competitor' : 'New competitors'} entered your 3-pack.
          </h1>
          <p>
            ${biz}'s territory has ${list.length === 1 ? 'a new entrant' : 'new entrants'}:
          </p>
          <ul style="padding-left:18px;color:#e4e4e7;">
            ${list.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}
          </ul>
          ${more ? `<p style="color:#a1a1aa;font-size:13px;">${escapeHtml(more.trim())}</p>` : ''}
          <p style="margin:24px 0;">
            ${ctaButton(target.dashboardUrl, 'Review competitors →')}
          </p>
        `),
        text: `New competitors in ${target.businessName}'s 3-pack: ${list.join(', ')}${more}\n${target.dashboardUrl}`,
        slackText: `🆕 *${list.length === 1 ? 'New competitor' : 'New competitors'}* in *${target.businessName}*'s 3-pack: ${list.join(', ')}${more}. <${target.dashboardUrl}|Review>`,
      };
    }
    case 'momentum_reversal': {
      const subject =
        event.to === 'positive'
          ? `↗ Momentum turned positive — ${target.businessName}`
          : `↘ Momentum turned negative — ${target.businessName}`;
      return {
        subject,
        html: emailShell(`
          <h1 style="font-size:22px;color:#ededed;margin:0 0 12px;">
            Momentum flipped ${event.from} → ${event.to}.
          </h1>
          <p>
            ${biz}'s momentum is now <strong>${event.momentum > 0 ? '+' : ''}${event.momentum}</strong>.
            ${
              event.to === 'positive'
                ? "Whatever you changed last cycle is working — keep going."
                : "Worth investigating — competitor activity, GBP edit, or a citation slip."
            }
          </p>
          <p style="margin:24px 0;">
            ${ctaButton(target.dashboardUrl, 'Open dashboard →')}
          </p>
        `),
        text: `Momentum flipped ${event.from} → ${event.to} for ${target.businessName}. Now ${event.momentum > 0 ? '+' : ''}${event.momentum}.\n${target.dashboardUrl}`,
        slackText: `${event.to === 'positive' ? '↗' : '↘'} *Momentum ${event.from} → ${event.to}* for *${target.businessName}* (${event.momentum > 0 ? '+' : ''}${event.momentum}). <${target.dashboardUrl}|Open dashboard>`,
      };
    }
    case 'cell_changes': {
      const subject = `${event.cellsImproved + event.cellsDegraded} cells moved — ${target.businessName}`;
      const direction =
        event.avgRankDelta < 0 ? 'improved on average' : 'slipped on average';
      return {
        subject,
        html: emailShell(`
          <h1 style="font-size:22px;color:#ededed;margin:0 0 12px;">
            ${event.cellsImproved + event.cellsDegraded} cells changed rank.
          </h1>
          <p>
            ${biz}: <strong style="color:#c5ff3a;">${event.cellsImproved} improved</strong> ·
            <strong style="color:#ff9f3a;">${event.cellsDegraded} degraded</strong>.
            Average position ${direction}.
          </p>
          <p style="margin:24px 0;">
            ${ctaButton(target.dashboardUrl, 'See the heatmap →')}
          </p>
        `),
        text: `${event.cellsImproved + event.cellsDegraded} cells moved for ${target.businessName}: ${event.cellsImproved} improved, ${event.cellsDegraded} degraded.\n${target.dashboardUrl}`,
        slackText: `🟩 *${event.cellsImproved} improved* / 🟥 *${event.cellsDegraded} degraded* — *${target.businessName}*. <${target.dashboardUrl}|Open heatmap>`,
      };
    }
  }
}

// ─── tiny HTML helpers (mirror lib/email/resend.ts conventions) ───────────

function emailShell(body: string): string {
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
            Manage these alerts from your client settings.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function ctaButton(href: string, label: string): string {
  return `<a href="${escapeAttr(href)}" style="display:inline-block;padding:12px 20px;background:#c5ff3a;color:#000;font-weight:700;text-decoration:none;border-radius:6px;font-size:15px;">${escapeHtml(label)}</a>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/&/g, '&amp;');
}
