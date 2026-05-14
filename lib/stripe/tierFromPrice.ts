/**
 * Map a Stripe Price ID to a TurfMap SubscriptionTier.
 *
 * The webhook receives subscription.created / .updated events with a
 * single subscription item carrying a `price.id`. We compare against
 * the four Pulse / Pulse+ price IDs in env to resolve the tier the
 * buyer is on. Cadence (monthly vs annual) doesn't affect tier — both
 * cadences of Pulse map to 'pulse'.
 *
 * Returns null when the price doesn't match any known recurring tier.
 * That happens for one-time products (TurfScan / Audit / Strategy)
 * which run through Stripe in `mode: 'payment'` and never produce a
 * Subscription, so we never hit this code path for them. If we DO see
 * a subscription with an unknown price, the webhook logs + skips —
 * better than guessing wrong.
 */

import type { SubscriptionTier } from '@/lib/supabase/types';

const PRICE_ENV_TO_TIER: Record<string, SubscriptionTier> = {
  NEXT_PUBLIC_STRIPE_PRICE_PULSE_MONTHLY: 'pulse',
  NEXT_PUBLIC_STRIPE_PRICE_PULSE_ANNUAL: 'pulse',
  NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_MONTHLY: 'pulse_plus',
  NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_ANNUAL: 'pulse_plus',
};

/** Look up which TurfMap tier corresponds to a Stripe Price ID.
 *  O(1) — builds a price→tier lookup at call time from env.
 *  Returns null for unknown prices. */
export function tierFromPriceId(priceId: string): SubscriptionTier | null {
  for (const [envKey, tier] of Object.entries(PRICE_ENV_TO_TIER)) {
    if (process.env[envKey] === priceId) return tier;
  }
  return null;
}
