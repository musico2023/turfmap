/**
 * Per-location billing — Stripe subscription-item helpers.
 *
 * Pulse + Pulse+ subscriptions carry TWO items: the base tier price
 * (qty 1, the $39 / $89 monthly fee) and an "extra location" price
 * with quantity = max(0, num_locations - 1). Adding a 4th location
 * to a Pulse subscription with 3 existing locations bumps the
 * extra-location item's quantity from 2 → 3; Stripe handles
 * proration automatically.
 *
 * Public marketing pricing (line 429-432 of app/page.tsx):
 *   Pulse  → +$19/mo per additional location
 *   Pulse+ → +$29/mo per additional location
 *
 * 3-month commitment:
 *   Subscription Schedules lock the subscription itself for 3 months
 *   on Pulse+ monthly. Adding/removing extra-location items mid-cycle
 *   is unaffected — quantity changes are proration events, not phase
 *   transitions. Buyers stay flexible on locations even while
 *   committed on the base tier.
 *
 * Required env (production + preview):
 *   NEXT_PUBLIC_STRIPE_PRICE_PULSE_EXTRA_LOCATION_MONTHLY
 *   NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_EXTRA_LOCATION_MONTHLY
 */

import type Stripe from 'stripe';
import { getStripe } from './client';
import type { SubscriptionTier } from '@/lib/supabase/types';

/** Resolve the extra-location Stripe Price ID for a tier, or null if
 *  the tier doesn't have a per-location add-on (or env isn't set). */
export function extraLocationPriceForTier(
  tier: SubscriptionTier
): string | null {
  if (tier === 'pulse') {
    return process.env.NEXT_PUBLIC_STRIPE_PRICE_PULSE_EXTRA_LOCATION_MONTHLY ?? null;
  }
  if (tier === 'pulse_plus') {
    return (
      process.env.NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_EXTRA_LOCATION_MONTHLY ?? null
    );
  }
  return null;
}

/** Display-only marketing price for a tier's extra-location add-on,
 *  in dollars. Source of truth is Stripe — we use this only for UI
 *  copy that surfaces the cost before round-tripping to Stripe. */
export function extraLocationDollarsForTier(tier: SubscriptionTier): number {
  if (tier === 'pulse_plus') return 29;
  if (tier === 'pulse') return 19;
  return 0;
}

/** Identify the extra-location item on a multi-item subscription, if
 *  one exists. Matches by Price ID against the env-resolved
 *  extra-location prices for both tiers (a sub upgraded from Pulse to
 *  Pulse+ might have either price attached). Returns null when the
 *  sub has no extra-location item yet. */
function findExtraLocationItem(
  sub: Stripe.Subscription
): Stripe.SubscriptionItem | null {
  const pulseExtra = extraLocationPriceForTier('pulse');
  const pulsePlusExtra = extraLocationPriceForTier('pulse_plus');
  for (const item of sub.items.data) {
    const priceId =
      typeof item.price === 'string' ? item.price : item.price.id;
    if (priceId === pulseExtra || priceId === pulsePlusExtra) {
      return item;
    }
  }
  return null;
}

export type SyncResult =
  | { ok: true; quantity: number; itemId: string; created: boolean }
  | {
      ok: false;
      kind:
        | 'stripe_not_configured'
        | 'price_not_configured'
        | 'subscription_not_found'
        | 'remote_error';
      message: string;
    };

/**
 * Idempotently set the extra-location item's quantity on a
 * subscription to match `numLocations - 1`. If the sub doesn't yet
 * have the item attached (e.g. pre-launch buyer from before
 * per-location billing shipped), creates it inline.
 *
 * Stripe handles proration automatically on quantity changes when
 * proration_behavior='create_prorations' (the default). The buyer
 * sees the prorated charge or credit on their next invoice.
 *
 * Returns ok=false envelopes for missing config / not-found —
 * callers should soft-fail (the location row already exists; we
 * don't want to roll it back just because Stripe wiring is missing).
 * Pre-launch / agency-managed clients legitimately have no Stripe
 * subscription and this should no-op cleanly there.
 */
export async function syncExtraLocationQuantity(args: {
  subscriptionId: string;
  tier: SubscriptionTier;
  numLocations: number;
}): Promise<SyncResult> {
  const stripe = await getStripe();
  if (!stripe) {
    return {
      ok: false,
      kind: 'stripe_not_configured',
      message: 'STRIPE_SECRET_KEY is not set',
    };
  }
  const extraPriceId = extraLocationPriceForTier(args.tier);
  if (!extraPriceId) {
    return {
      ok: false,
      kind: 'price_not_configured',
      message: `Extra-location price not set for ${args.tier}. Configure NEXT_PUBLIC_STRIPE_PRICE_${args.tier === 'pulse_plus' ? 'PULSEPLUS' : 'PULSE'}_EXTRA_LOCATION_MONTHLY.`,
    };
  }

  // Quantity is locations beyond the first. 1 location = 0 extras,
  // 5 locations = 4 extras. Floor at 0 so we never send negative qty.
  const quantity = Math.max(0, args.numLocations - 1);

  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.retrieve(args.subscriptionId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes('no such subscription')) {
      return {
        ok: false,
        kind: 'subscription_not_found',
        message: `Stripe subscription ${args.subscriptionId} not found`,
      };
    }
    return { ok: false, kind: 'remote_error', message: msg };
  }

  const existingItem = findExtraLocationItem(sub);

  // Already at the target quantity — no Stripe call needed. Cuts the
  // common case down to one retrieve.
  if (existingItem && existingItem.quantity === quantity) {
    return {
      ok: true,
      quantity,
      itemId: existingItem.id,
      created: false,
    };
  }

  try {
    if (existingItem) {
      const updated = await stripe.subscriptionItems.update(existingItem.id, {
        quantity,
        proration_behavior: 'create_prorations',
      });
      return { ok: true, quantity, itemId: updated.id, created: false };
    }
    // No existing item — attach a fresh one at the target quantity.
    // Skip the create call entirely when quantity is 0 (the common
    // case for single-location buyers — keeps the sub clean of zero-qty
    // line items in the Stripe dashboard).
    if (quantity === 0) {
      return { ok: true, quantity: 0, itemId: '', created: false };
    }
    const created = await stripe.subscriptionItems.create({
      subscription: args.subscriptionId,
      price: extraPriceId,
      quantity,
      proration_behavior: 'create_prorations',
    });
    return { ok: true, quantity, itemId: created.id, created: true };
  } catch (e) {
    return {
      ok: false,
      kind: 'remote_error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Attach an extra-location item at quantity 0 to a freshly-created
 * subscription. Called by /api/orders/fulfill so every new sub has
 * the structure ready before the buyer ever adds a second location.
 *
 * Why pre-attach instead of creating on-demand: this lets us bump
 * quantity from 0 → 1 on first add (cheap mutate-quantity call) vs
 * having to choose between create vs update at every add.
 *
 * No-ops cleanly when env isn't set or Stripe is unconfigured —
 * order-fulfill calls this best-effort, doesn't roll back on failure.
 */
export async function attachExtraLocationItemAtZero(args: {
  subscriptionId: string;
  tier: SubscriptionTier;
}): Promise<SyncResult> {
  // Pre-attaching at qty 0 just confirms env config + sub existence;
  // the actual line item is added lazily on first sync up. This keeps
  // the Stripe dashboard tidy — single-location buyers don't see a
  // ghost qty-0 row on every Pulse / Pulse+ subscription.
  return syncExtraLocationQuantity({
    subscriptionId: args.subscriptionId,
    tier: args.tier,
    numLocations: 1,
  });
}
