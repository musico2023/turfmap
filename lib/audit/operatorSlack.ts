/**
 * Operator-facing Slack notifications for the Visibility Audit
 * pipeline. Distinct from the per-client Slack webhooks stored on
 * clients.slack_webhook_url (which alert ON the client's data via
 * the AlertPrefs system) — these post to ONE operator channel
 * (#llm-leads) so Anthony has a feed of audit-pipeline events
 * across all buyers.
 *
 * Configuration:
 *   OPERATOR_SLACK_WEBHOOK_URL — single Slack incoming-webhook URL
 *                                for #llm-leads. Optional. When unset
 *                                postOperatorSlack() no-ops + returns
 *                                false instead of throwing.
 */

const ENV_KEY = 'OPERATOR_SLACK_WEBHOOK_URL';

/** Send a Slack message to the operator #llm-leads channel.
 *  Fail-soft — caller doesn't gate on the return value (Slack down
 *  shouldn't break a cron sweep). Returns true on success, false on
 *  any failure including no-webhook-configured. Never throws. */
export async function postOperatorSlack(args: {
  /** Single-line summary — appears as the message text and shows
   *  in the channel preview / push notification. */
  text: string;
  /** Optional rich blocks. Keep concise; #llm-leads is a feed, not
   *  a dashboard. */
  blocks?: unknown[];
}): Promise<boolean> {
  const webhook = process.env[ENV_KEY];
  if (!webhook) {
    console.warn(
      `[operator-slack] ${ENV_KEY} not set — skipping notification: "${args.text}"`
    );
    return false;
  }
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: args.text, blocks: args.blocks }),
    });
    if (!res.ok) {
      console.error(
        `[operator-slack] webhook returned ${res.status}: "${args.text}"`
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      `[operator-slack] webhook call threw: "${args.text}":`,
      e instanceof Error ? e.message : String(e)
    );
    return false;
  }
}

// ─── Pre-built notification templates ─────────────────────────────────
//
// One function per spec'd event. Each builds the appropriate text +
// blocks payload from a typed input. Centralized here so the cron
// sweep + the fulfill route call the same constructor (no copy-paste
// drift in the formatting between sites).

export type AuditNotificationContext = {
  businessName: string;
  trade: string;
  market: string;
  currentTurfScore: number;
  llmFitScore: number;
  /** URL to the audit row in the agency dashboard for one-click
   *  drill-down. Empty string when the dashboard route doesn't
   *  exist yet (Phase 4). */
  auditDashboardUrl: string;
};

/** "🎯 New LLM-fit audit purchased" — fires on Stripe webhook for
 *  audits scoring 4-5. Most actionable signal in the feed. */
export async function notifyLlmFitAudit(
  ctx: AuditNotificationContext
): Promise<boolean> {
  return postOperatorSlack({
    text: `🎯 New LLM-fit audit purchased: ${ctx.businessName} (Fit ${ctx.llmFitScore}/5)`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*🎯 New LLM-fit audit purchased*\n*${ctx.businessName}* — ${ctx.trade} in ${ctx.market}\nTurfScore: ${ctx.currentTurfScore} · LLM Fit: ${ctx.llmFitScore}/5`,
        },
      },
      ctx.auditDashboardUrl
        ? {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `<${ctx.auditDashboardUrl}|Open audit →>`,
              },
            ],
          }
        : undefined,
    ].filter(Boolean),
  });
}

/** "⏰ Audit unscheduled" — buyer hasn't booked a Cal.com slot 7
 *  days after purchase. Operator follow-up cue. */
export async function notifyAuditUnscheduled(
  ctx: AuditNotificationContext
): Promise<boolean> {
  return postOperatorSlack({
    text: `⏰ Audit unscheduled: ${ctx.businessName}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*⏰ Audit unscheduled (7+ days post-purchase)*\n*${ctx.businessName}* — ${ctx.trade} in ${ctx.market}\nTurfScore: ${ctx.currentTurfScore} · LLM Fit: ${ctx.llmFitScore}/5`,
        },
      },
    ],
  });
}

/** "📅 60-day check-in unresponsive" — buyer hit day 67 without
 *  scheduling. Auto follow-up email already sent; Slack alert is
 *  the manual-touch cue. */
export async function notifySixtyDayUnresponsive(
  ctx: AuditNotificationContext
): Promise<boolean> {
  return postOperatorSlack({
    text: `📅 60-day check-in unresponsive: ${ctx.businessName}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*📅 60-day check-in unresponsive (day 67)*\n*${ctx.businessName}* — ${ctx.trade} in ${ctx.market}\nManual outreach time. Buyer was day-53 prompted + day-67 nudged via email; both went unanswered.`,
        },
      },
    ],
  });
}

// ─── Funnel-conversion notifications ──────────────────────────────────
//
// Three events surface in #llm-leads as part of the lander funnel feed:
//
//   💵 TurfScan purchase  — any paid scan (any tier, any coupon).
//   🎯 Audit upgrade      — $197 1-click upgrade off the success page.
//   🆓 Cold scan complete — COLDSCAN free buyer hit results.
//
// Each notification carries the buyer's business + the attribution
// (utm_source / coupon / lander) so the operator can see what creative
// is converting in real time without opening the dashboard.

export type TurfScanPurchaseContext = {
  /** Business name as the buyer typed on intake. */
  businessName: string;
  /** 'scan' | 'audit' | 'strategy' | 'pulse' | 'pulse_plus' — comes
   *  straight off Stripe session.metadata.tier. */
  tier: string;
  /** Stripe amount_total in cents. 0 if 100%-off coupon. */
  amountCents: number;
  /** UPPERCASE coupon code applied, or null. */
  coupon: string | null;
  /** Primary keyword the scan ran on. */
  keyword: string;
  /** City from Mapbox / Nominatim components — short geo for the
   *  Slack preview. Falls back to empty string when unknown. */
  city: string;
  /** utm_source on the Stripe metadata — typically 'meta_cold',
   *  'cold_email', 'fourdots_homepage', 'warm_reactivation'. */
  utmSource: string | null;
  /** utm_content — meta ad creative variant or similar. */
  utmContent: string | null;
  /** Cold-cohort prospect id when set. Lets the operator pivot to the
   *  outreach record without re-deriving from the Stripe metadata. */
  prospectId: string | null;
  /** Buyer-facing share/portal URL for one-click drill-down. */
  shareUrl: string;
};

/** "💵 New TurfScan purchase" — fires from /api/orders/fulfill once
 *  the scan ROW lands. Covers all paid lander tiers; cold-email free
 *  buyers route through notifyColdscanCompleted instead. */
export async function notifyTurfScanPurchase(
  ctx: TurfScanPurchaseContext
): Promise<boolean> {
  const amountStr =
    ctx.amountCents > 0 ? `$${(ctx.amountCents / 100).toFixed(2)}` : 'free';
  const couponStr = ctx.coupon ? ` · ${ctx.coupon}` : '';
  const utmStr = ctx.utmSource ? ` · ${ctx.utmSource}` : '';
  const contentStr = ctx.utmContent ? ` / ${ctx.utmContent}` : '';
  const cohortStr = ctx.prospectId ? ` · cold-email lead` : '';
  return postOperatorSlack({
    text: `💵 TurfScan purchase: ${ctx.businessName} (${ctx.tier} · ${amountStr})`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*💵 New TurfScan purchase*\n*${ctx.businessName}* — "${ctx.keyword}"${ctx.city ? ` in ${ctx.city}` : ''}\n\`${ctx.tier}\` · ${amountStr}${couponStr}${utmStr}${contentStr}${cohortStr}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `<${ctx.shareUrl}|Open dashboard →>`,
          },
        ],
      },
    ],
  });
}

export type AuditUpgradePurchaseContext = {
  businessName: string;
  /** $197 net charge in cents (always 19700, but parameterized for
   *  defense-in-depth if pricing changes). */
  amountCents: number;
  /** Original scan tier the buyer upgraded FROM. Always 'scan' today
   *  but parameterized so the future audit-upgrade-from-pulse path
   *  (if it lands) can populate this. */
  fromTier: string;
  /** Original lead_order id for cross-reference in the agency view. */
  originalLeadOrderId: string;
  /** utm_source carried through from the scan purchase. */
  utmSource: string | null;
  /** When the upgrade came from a cold-email prospect. */
  prospectId: string | null;
  /** Direct link to the buyer's agency dashboard. Empty string when
   *  the client row isn't materialized yet (pending-intake upgrades). */
  auditDashboardUrl: string;
};

/** "🎯 Audit upgrade ($197)" — fires from
 *  /api/upgrade/audit/confirm after PaymentIntent.status === 'succeeded'.
 *  Distinct from notifyLlmFitAudit (which fires for high-fit audit-tier
 *  PURCHASES, not upgrades). Both can fire for the same buyer if they
 *  upgrade and the resulting audit scores 4-5. */
export async function notifyAuditUpgradePurchase(
  ctx: AuditUpgradePurchaseContext
): Promise<boolean> {
  const amountStr = `$${(ctx.amountCents / 100).toFixed(2)}`;
  const utmStr = ctx.utmSource ? ` · ${ctx.utmSource}` : '';
  const cohortStr = ctx.prospectId ? ` · cold-email lead` : '';
  return postOperatorSlack({
    text: `🎯 Audit upgrade (${amountStr}): ${ctx.businessName}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*🎯 New audit upgrade*\n*${ctx.businessName}* — ${amountStr} 1-click upgrade from \`${ctx.fromTier}\`${utmStr}${cohortStr}`,
        },
      },
      ctx.auditDashboardUrl
        ? {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `<${ctx.auditDashboardUrl}|Open audit →>`,
              },
            ],
          }
        : undefined,
    ].filter(Boolean),
  });
}

export type ColdscanCompletedContext = {
  businessName: string;
  /** Prospect's home city from the lead-gen geo backfill. */
  city: string;
  /** Trade the cold-email pipeline classified the prospect into —
   *  populates the keyword. */
  trade: string;
  /** Final score on the just-completed scan. */
  turfScore: number;
  /** Buyer-facing /share/<id> URL — operator can preview the same page
   *  the prospect will land on. */
  shareUrl: string;
  /** Cold-cohort prospect id for cross-reference to the outreach row. */
  prospectId: string;
  /** utm_source carried through from the lander click — usually
   *  'cold_email' when the email link drove the conversion. */
  utmSource: string | null;
};

/** "🆓 Cold scan completed" — fires from
 *  /api/yourmap/coldscan-fulfill after the share link is created and
 *  the AI Coach Fix List has pre-generated. Signals to the operator
 *  that a COLDSCAN free buyer is about to see their results page; the
 *  cold-stage3 follow-up email pitching the audit will fire next on
 *  the engaged trigger. */
export async function notifyColdscanCompleted(
  ctx: ColdscanCompletedContext
): Promise<boolean> {
  const utmStr = ctx.utmSource ? ` · ${ctx.utmSource}` : '';
  return postOperatorSlack({
    text: `🆓 Cold scan completed: ${ctx.businessName} (TurfScore ${ctx.turfScore})`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*🆓 Cold scan completed*\n*${ctx.businessName}* — ${ctx.trade} in ${ctx.city}\nTurfScore: ${ctx.turfScore}${utmStr}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `<${ctx.shareUrl}|Preview share page →>`,
          },
        ],
      },
    ],
  });
}
