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

import { render } from '@react-email/components';
import { sendEmail } from '@/lib/email/resend';
import { AlertEmail } from '@/components/email/AlertEmail';
import { P } from '@/components/email/EmailLayout';
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
  const { subject, html, text, slackText } = await renderAlert(event, target);

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

async function renderAlert(
  event: AlertEvent,
  target: DispatchTarget
): Promise<Rendered> {
  const FOOTNOTE = 'Manage these alerts from your client settings.';
  switch (event.type) {
    case 'score_movement': {
      const arrow = event.direction === 'up' ? '↑' : '↓';
      const sign = event.delta > 0 ? '+' : '';
      const subject = `${arrow} TurfScore ${sign}${event.delta} — ${target.businessName}`;
      const headline =
        event.direction === 'up'
          ? `Your TurfScore moved up by ${event.delta} points.`
          : `Your TurfScore dropped by ${Math.abs(event.delta)} points.`;
      const newColor = event.direction === 'up' ? '#c5ff3a' : '#ff9f3a';
      const html = await render(
        AlertEmail({
          preview: subject,
          headline,
          ctaUrl: target.dashboardUrl,
          ctaLabel: 'Open dashboard →',
          footnote: FOOTNOTE,
          children: P({
            children: [
              <strong key="b">{target.businessName}</strong>,
              ' moved from ',
              <span key="p" style={{ color: '#a1a1aa' }}>{event.priorScore}</span>,
              ' to ',
              <strong key="n" style={{ color: newColor }}>{event.newScore}</strong>,
              '.',
            ],
          }),
        })
      );
      return {
        subject,
        html,
        text: `${headline}\n${target.businessName} moved from ${event.priorScore} to ${event.newScore}.\n\n${target.dashboardUrl}`,
        slackText: `${arrow} *TurfScore ${sign}${event.delta}* for *${target.businessName}* — ${event.priorScore} → ${event.newScore}. <${target.dashboardUrl}|Open dashboard>`,
      };
    }
    case 'competitor_entries': {
      const list = event.newCompetitors.slice(0, 5);
      const moreCount =
        event.newCompetitors.length > 5
          ? event.newCompetitors.length - 5
          : 0;
      const subject = `New competitor${list.length === 1 ? '' : 's'} in your 3-pack — ${target.businessName}`;
      const headline = `${list.length === 1 ? 'New competitor' : 'New competitors'} entered your 3-pack.`;
      const html = await render(
        AlertEmail({
          preview: subject,
          headline,
          ctaUrl: target.dashboardUrl,
          ctaLabel: 'Review competitors →',
          footnote: FOOTNOTE,
          children: (
            <>
              {P({
                children: `${target.businessName}'s territory has ${list.length === 1 ? 'a new entrant' : 'new entrants'}:`,
              })}
              <ul style={{ paddingLeft: 18, color: '#e4e4e7', margin: '0 0 8px' }}>
                {list.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              {moreCount > 0 &&
                P({
                  children: `+${moreCount} more`,
                })}
            </>
          ),
        })
      );
      return {
        subject,
        html,
        text: `New competitors in ${target.businessName}'s 3-pack: ${list.join(', ')}${moreCount > 0 ? ` (+${moreCount} more)` : ''}\n${target.dashboardUrl}`,
        slackText: `🆕 *${list.length === 1 ? 'New competitor' : 'New competitors'}* in *${target.businessName}*'s 3-pack: ${list.join(', ')}${moreCount > 0 ? ` (+${moreCount} more)` : ''}. <${target.dashboardUrl}|Review>`,
      };
    }
    case 'momentum_reversal': {
      const subject =
        event.to === 'positive'
          ? `↗ Momentum turned positive — ${target.businessName}`
          : `↘ Momentum turned negative — ${target.businessName}`;
      const headline = `Momentum flipped ${event.from} → ${event.to}.`;
      const advice =
        event.to === 'positive'
          ? 'Whatever you changed last cycle is working — keep going.'
          : 'Worth investigating — competitor activity, GBP edit, or a citation slip.';
      const html = await render(
        AlertEmail({
          preview: subject,
          headline,
          ctaUrl: target.dashboardUrl,
          ctaLabel: 'Open dashboard →',
          footnote: FOOTNOTE,
          children: P({
            children: [
              `${target.businessName}'s momentum is now `,
              <strong key="m">{`${event.momentum > 0 ? '+' : ''}${event.momentum}`}</strong>,
              `. ${advice}`,
            ],
          }),
        })
      );
      return {
        subject,
        html,
        text: `Momentum flipped ${event.from} → ${event.to} for ${target.businessName}. Now ${event.momentum > 0 ? '+' : ''}${event.momentum}.\n${target.dashboardUrl}`,
        slackText: `${event.to === 'positive' ? '↗' : '↘'} *Momentum ${event.from} → ${event.to}* for *${target.businessName}* (${event.momentum > 0 ? '+' : ''}${event.momentum}). <${target.dashboardUrl}|Open dashboard>`,
      };
    }
    case 'cell_changes': {
      const subject = `${event.cellsImproved + event.cellsDegraded} cells moved — ${target.businessName}`;
      const direction =
        event.avgRankDelta < 0 ? 'improved on average' : 'slipped on average';
      const headline = `${event.cellsImproved + event.cellsDegraded} cells changed rank.`;
      const html = await render(
        AlertEmail({
          preview: subject,
          headline,
          ctaUrl: target.dashboardUrl,
          ctaLabel: 'See the heatmap →',
          footnote: FOOTNOTE,
          children: P({
            children: [
              `${target.businessName}: `,
              <strong key="i" style={{ color: '#c5ff3a' }}>{`${event.cellsImproved} improved`}</strong>,
              ' · ',
              <strong key="d" style={{ color: '#ff9f3a' }}>{`${event.cellsDegraded} degraded`}</strong>,
              `. Average position ${direction}.`,
            ],
          }),
        })
      );
      return {
        subject,
        html,
        text: `${event.cellsImproved + event.cellsDegraded} cells moved for ${target.businessName}: ${event.cellsImproved} improved, ${event.cellsDegraded} degraded.\n${target.dashboardUrl}`,
        slackText: `🟩 *${event.cellsImproved} improved* / 🟥 *${event.cellsDegraded} degraded* — *${target.businessName}*. <${target.dashboardUrl}|Open heatmap>`,
      };
    }
  }
}
