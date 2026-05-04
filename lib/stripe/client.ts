/**
 * Shared Stripe SDK access for server-side code.
 *
 * Lazy-imports the `stripe` module so build environments without the
 * dep installed don't break (matches the pattern used in
 * /api/checkout/[tier]/route.ts).
 *
 * Every consumer should call `getStripe()` and handle the
 * `null` return — null means STRIPE_SECRET_KEY isn't set and the
 * caller should respond with a clear 503 telling the operator to
 * configure Stripe before the route can fire. This is the
 * pre-Stripe-launch safe state.
 */

import type Stripe from 'stripe';

let cached: Stripe | null = null;

/** Returns a singleton Stripe instance, or null if STRIPE_SECRET_KEY
 *  isn't configured. Routes that hit this should 503 with a clear
 *  message when null comes back. */
export async function getStripe(): Promise<Stripe | null> {
  if (cached) return cached;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;

  // Lazy import — keeps the SDK out of bundles where Stripe isn't
  // configured.
  let StripeCtor: typeof import('stripe').default;
  try {
    StripeCtor = (await import('stripe')).default;
  } catch {
    return null;
  }

  cached = new StripeCtor(secretKey);
  return cached;
}

/** Helper for routes — produces the canonical 503 error envelope when
 *  Stripe isn't yet configured. Caller should `return` this directly. */
export const STRIPE_NOT_CONFIGURED_ERROR = {
  error:
    'Checkout not yet configured. Set STRIPE_SECRET_KEY in your environment.',
} as const;
