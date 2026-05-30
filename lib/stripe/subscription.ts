/**
 * Stripe Subscription + Subscription Schedule helpers.
 *
 * Used by the agency dashboard's subscription panel + the
 * /api/subscription/cancel endpoint. Both surfaces need to know:
 *
 *   - The subscription's current_period_end (when does the next
 *     invoice fire / cancellation take effect).
 *   - cancel_at_period_end (already scheduled to cancel?).
 *   - The Subscription Schedule's current_phase (for Pulse+ monthly
 *     buyers in their 3-month committed window — phase 1 — we surface
 *     "minimum commitment ends YYYY-MM-DD" and disable immediate
 *     cancel).
 *
 * Designed to fail soft: when STRIPE_SECRET_KEY is unset OR the
 * subscription is missing/deleted, returns a typed "unavailable"
 * envelope. The dashboard renders a graceful pre-launch placeholder
 * in that case rather than blowing up the page.
 */

import { getStripe } from './client';

export type SubscriptionSummary =
  | {
      ok: true;
      subscriptionId: string;
      /** Stripe lifecycle status. */
      status:
        | 'trialing'
        | 'active'
        | 'past_due'
        | 'canceled'
        | 'unpaid'
        | 'incomplete'
        | 'incomplete_expired'
        | 'paused';
      /** ISO8601 — end of the current billing period. cancellation
       *  takes effect at this timestamp when cancel_at_period_end. */
      currentPeriodEnd: string;
      /** Already scheduled to cancel at the end of the period? */
      cancelAtPeriodEnd: boolean;
      /** When the subscription is wrapped in a Subscription Schedule
       *  (Pulse+ monthly buyers in their 3-month committed phase),
       *  this is the ISO8601 timestamp marking the end of the
       *  committed phase. Cancellation in this window is rejected;
       *  the operator must wait for this date. NULL when no schedule
       *  is wrapping (Pulse, Pulse+ annual, or Pulse+ monthly past
       *  the committed phase). */
      minimumCommitmentEnd: string | null;
      /** True when the buyer is still inside the Subscription
       *  Schedule's committed phase. Convenience derived from
       *  minimumCommitmentEnd > now. */
      inCommittedPhase: boolean;
      /** Stripe Customer object id — for the cancel route to invoke
       *  the right subscription-lookup. */
      customerId: string;
    }
  | {
      ok: false;
      kind: 'stripe_not_configured' | 'not_found' | 'remote_error';
      message: string;
    };

/**
 * Load a subscription's billing-cycle + commitment state. Pulls the
 * Stripe Subscription AND, if one exists, the wrapping Subscription
 * Schedule so we can surface the committed-phase end date.
 */
export async function loadSubscriptionSummary(
  subscriptionId: string
): Promise<SubscriptionSummary> {
  const stripe = await getStripe();
  if (!stripe) {
    return {
      ok: false,
      kind: 'stripe_not_configured',
      message: 'STRIPE_SECRET_KEY is not set',
    };
  }

  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['schedule'],
    });
    const customerId =
      typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

    // Subscription Schedule lookup. The expand=['schedule'] above
    // attaches the schedule object directly when one exists. Read
    // current_phase to detect "in committed phase" — phase[0] is the
    // 3-month committed iteration; phase[1] is the open-ended monthly
    // continuation.
    let minimumCommitmentEnd: string | null = null;
    if (sub.schedule && typeof sub.schedule !== 'string') {
      const schedule = sub.schedule;
      // current_phase carries { start_date, end_date } in seconds.
      // We only treat the FIRST phase as the committed window — once
      // the subscription has rolled into phase 2 (open-ended), there's
      // no committed-phase end to surface.
      if (
        schedule.phases &&
        schedule.phases.length > 1 &&
        schedule.current_phase
      ) {
        const firstPhase = schedule.phases[0];
        const inFirstPhase =
          schedule.current_phase.start_date === firstPhase.start_date;
        if (inFirstPhase) {
          minimumCommitmentEnd = new Date(
            schedule.current_phase.end_date * 1000
          ).toISOString();
        }
      }
    }

    // Stripe types use `current_period_end` on the subscription as a
    // unix-seconds number.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const periodEndSec = (sub as any).current_period_end as number | undefined;
    const currentPeriodEnd = periodEndSec
      ? new Date(periodEndSec * 1000).toISOString()
      : new Date().toISOString();

    const inCommittedPhase =
      minimumCommitmentEnd != null &&
      new Date(minimumCommitmentEnd).getTime() > Date.now();

    return {
      ok: true,
      subscriptionId: sub.id,
      status: sub.status as SubscriptionSummary extends { ok: true }
        ? SubscriptionSummary['status']
        : never,
      currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      minimumCommitmentEnd,
      inCommittedPhase,
      customerId,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes('no such subscription')) {
      return {
        ok: false,
        kind: 'not_found',
        message: `Stripe subscription ${subscriptionId} not found`,
      };
    }
    return { ok: false, kind: 'remote_error', message: msg };
  }
}

/**
 * Create a Stripe Customer Portal session for a client. Returns the
 * hosted-portal URL to redirect the user to.
 *
 * The Customer Portal is Stripe's hosted UI for invoice access,
 * payment-method updates, plan changes (where configured at the
 * Stripe-account level), and cancellation. Honors Subscription
 * Schedules — a "cancel" inside the committed first phase applies
 * cancel_at_period_end at the end of the schedule's current phase
 * rather than the immediate billing period.
 */
export async function createBillingPortalSession(args: {
  customerId: string;
  returnUrl: string;
}): Promise<
  | { ok: true; url: string }
  | {
      ok: false;
      kind: 'stripe_not_configured' | 'remote_error';
      message: string;
    }
> {
  const stripe = await getStripe();
  if (!stripe) {
    return {
      ok: false,
      kind: 'stripe_not_configured',
      message: 'STRIPE_SECRET_KEY is not set',
    };
  }
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: args.customerId,
      return_url: args.returnUrl,
    });
    return { ok: true, url: session.url };
  } catch (e) {
    return {
      ok: false,
      kind: 'remote_error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Swap a subscription's price (and therefore tier) inline via the
 * Stripe API. Used by the Pulse → Pulse+ upgrade button on the
 * portal. Stripe handles proration — the buyer is charged
 * immediately for the prorated cost difference, then continues at
 * the new price going forward.
 *
 * Assumes the subscription has exactly one item (true for our
 * tier model — each subscription is one Price). proration_behavior
 * 'always_invoice' creates an invoice that bills immediately rather
 * than queueing for next cycle.
 */
export async function updateSubscriptionPrice(args: {
  subscriptionId: string;
  newPriceId: string;
}): Promise<
  | { ok: true; subscriptionId: string }
  | {
      ok: false;
      kind: 'stripe_not_configured' | 'remote_error' | 'no_items';
      message: string;
    }
> {
  const stripe = await getStripe();
  if (!stripe) {
    return {
      ok: false,
      kind: 'stripe_not_configured',
      message: 'STRIPE_SECRET_KEY is not set',
    };
  }
  try {
    const sub = await stripe.subscriptions.retrieve(args.subscriptionId);
    if (sub.items.data.length === 0) {
      return {
        ok: false,
        kind: 'no_items',
        message: `subscription ${args.subscriptionId} has no items`,
      };
    }
    // Multi-item subs (post per-location billing) carry a base item +
    // an extra-location item. The price swap targets the BASE item —
    // we identify it by checking which item maps to a known tier
    // price (Pulse / Pulse+, monthly + annual). Stripe doesn't
    // guarantee item ordering, so reading items[0] is unsafe.
    const knownBasePrices = new Set(
      [
        process.env.NEXT_PUBLIC_STRIPE_PRICE_PULSE_MONTHLY,
        process.env.NEXT_PUBLIC_STRIPE_PRICE_PULSE_ANNUAL,
        process.env.NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_MONTHLY,
        process.env.NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_ANNUAL,
      ].filter((p): p is string => Boolean(p))
    );
    const baseItem = sub.items.data.find((it) => {
      const priceId = typeof it.price === 'string' ? it.price : it.price.id;
      return knownBasePrices.has(priceId);
    });
    if (!baseItem) {
      return {
        ok: false,
        kind: 'no_items',
        message: `subscription ${args.subscriptionId} has no item on a recognized base-tier price`,
      };
    }
    await stripe.subscriptions.update(args.subscriptionId, {
      items: [{ id: baseItem.id, price: args.newPriceId }],
      proration_behavior: 'always_invoice',
    });
    return { ok: true, subscriptionId: args.subscriptionId };
  } catch (e) {
    return {
      ok: false,
      kind: 'remote_error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Wrap a freshly-created Pulse+ monthly subscription in a Subscription
 * Schedule that enforces the 3-month minimum commitment.
 *
 * Pricing decision (2026-05-17): Pulse+ on monthly billing requires
 * a 3-month commitment. The Stripe-native primitive for this is
 * Subscription Schedules:
 * https://docs.stripe.com/billing/subscriptions/subscription-schedules
 *
 * Shape we install:
 *   Phase 1 — 3 iterations (months) at the Pulse+ monthly Price.
 *             Cancellation requested in months 1-2 still bills
 *             through end of phase 1 — enforced downstream by
 *             cancelAtPeriodEnd (which rejects with 'committed_phase').
 *   Phase 2 — open-ended at the same Price. No iterations cap, so
 *             the schedule continues indefinitely; the buyer can
 *             cancel at any period end from month 4 onward.
 *
 * Gates / idempotency:
 *   - Skip silently when the subscription already has a schedule
 *     (re-firing this on customer.subscription.updated is the
 *     defensive path — first call wraps, subsequent calls no-op).
 *   - Skip when the subscription is not on the Pulse+ monthly price
 *     (Pulse, Pulse+ annual, and one-time tiers don't need a
 *     commitment wrap — annual already has a 12-month implicit lock).
 *   - Returns a typed envelope so the webhook handler can log without
 *     500-ing — Stripe would retry and we'd hit the
 *     already-has-schedule path on the second try anyway.
 */
export async function ensurePulsePlusCommitmentSchedule(
  subscription: import('stripe').default.Subscription
): Promise<
  | { ok: true; kind: 'created'; scheduleId: string }
  | { ok: true; kind: 'skipped_already_scheduled' }
  | { ok: true; kind: 'skipped_wrong_tier' }
  | {
      ok: false;
      kind: 'stripe_not_configured' | 'remote_error' | 'no_items';
      message: string;
    }
> {
  const stripe = await getStripe();
  if (!stripe) {
    return {
      ok: false,
      kind: 'stripe_not_configured',
      message: 'STRIPE_SECRET_KEY is not set',
    };
  }

  // Idempotency: a sub that already has a schedule shouldn't be wrapped
  // again. Stripe would reject the create call anyway, but failing fast
  // here keeps the webhook log clean.
  if (subscription.schedule) {
    return { ok: true, kind: 'skipped_already_scheduled' };
  }

  // Gate: only Pulse+ monthly gets wrapped. Pulse (any cadence) and
  // Pulse+ annual don't have the 3-month commitment policy — annual
  // already has a 12-month implicit lock via the annual price.
  const pulsePlusMonthlyPriceId =
    process.env.NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_MONTHLY;
  if (!pulsePlusMonthlyPriceId) {
    return {
      ok: true,
      // Treat a missing env var as "wrong tier" so we don't 500 the
      // webhook in dev/preview environments without the Pulse+ Price
      // wired. Production deploys should have the env set.
      kind: 'skipped_wrong_tier',
    };
  }
  const isPulsePlusMonthly = subscription.items.data.some((item) => {
    const priceId = typeof item.price === 'string' ? item.price : item.price.id;
    return priceId === pulsePlusMonthlyPriceId;
  });
  if (!isPulsePlusMonthly) {
    return { ok: true, kind: 'skipped_wrong_tier' };
  }

  // Capture the subscription's existing items so phase 1 mirrors what
  // Stripe already booked — preserves item ids + quantities, which
  // includes the per-location $39/mo extras (if any) the buyer has
  // configured. The recurring Pulse+ price is always among them; the
  // one-time $99 TurfScan setup fee was an invoice item (not a
  // subscription item) so it won't appear here.
  const items = subscription.items.data.map((item) => {
    const priceId = typeof item.price === 'string' ? item.price : item.price.id;
    return { price: priceId, quantity: item.quantity ?? 1 };
  });
  if (items.length === 0) {
    return {
      ok: false,
      kind: 'no_items',
      message: `subscription ${subscription.id} has no items to mirror into the schedule`,
    };
  }

  try {
    // Step 1: create a Schedule from the live subscription. Stripe
    // mirrors the current state as a single phase with the
    // subscription's existing items + anchor.
    const created = await stripe.subscriptionSchedules.create({
      from_subscription: subscription.id,
    });

    // Step 2: rewrite the phase list to enforce the 3-month commitment.
    // Phase 1 has duration { month, count: 3 } — the committed window.
    // Phase 2 has no duration cap, so the schedule never naturally
    // "ends" — end_behavior: 'release' is still set so that if a
    // Stripe-side change ever does cause it to end, the subscription
    // falls back to standard month-to-month management rather than
    // being cancelled.
    //
    // proration_behavior: 'none' on the phase boundary avoids surprise
    // charges when the buyer transitions phase 1 → phase 2 (same price,
    // so no proration should fire, but explicit is safer).
    const updated = await stripe.subscriptionSchedules.update(created.id, {
      end_behavior: 'release',
      phases: [
        {
          items,
          duration: { interval: 'month', interval_count: 3 },
          proration_behavior: 'none',
        },
        {
          items,
          proration_behavior: 'none',
        },
      ],
    });
    return { ok: true, kind: 'created', scheduleId: updated.id };
  } catch (e) {
    return {
      ok: false,
      kind: 'remote_error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Schedule cancellation for the end of the current billing period.
 * No-op if already scheduled. Rejects if the subscription is still
 * in the Subscription Schedule's committed first phase — the route
 * handler converts that into a 409 with a helpful message.
 */
export async function cancelAtPeriodEnd(
  subscriptionId: string
): Promise<
  | { ok: true; cancelsAt: string }
  | { ok: false; kind: 'committed_phase' | 'remote_error' | 'stripe_not_configured'; message: string }
> {
  const summary = await loadSubscriptionSummary(subscriptionId);
  if (!summary.ok) {
    if (summary.kind === 'stripe_not_configured') {
      return { ok: false, kind: 'stripe_not_configured', message: summary.message };
    }
    return { ok: false, kind: 'remote_error', message: summary.message };
  }

  if (summary.inCommittedPhase && summary.minimumCommitmentEnd) {
    return {
      ok: false,
      kind: 'committed_phase',
      message: `Cancellation will take effect on ${summary.minimumCommitmentEnd.slice(0, 10)} (end of minimum commitment).`,
    };
  }

  const stripe = await getStripe();
  if (!stripe) {
    return {
      ok: false,
      kind: 'stripe_not_configured',
      message: 'STRIPE_SECRET_KEY is not set',
    };
  }

  try {
    const updated = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
    return {
      ok: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cancelsAt: new Date(((updated as any).current_period_end ?? 0) * 1000).toISOString(),
    };
  } catch (e) {
    return {
      ok: false,
      kind: 'remote_error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
