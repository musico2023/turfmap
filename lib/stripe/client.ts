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
 *
 * Mode resolution: the active Stripe mode (live vs. test) is decided
 * by the prefix of STRIPE_SECRET_KEY (sk_live_… vs. sk_test_…). Per
 * the Vercel pattern, we set the env var with different values per
 * environment scope:
 *   - production scope: live keys → sk_live_…
 *   - preview scope:    test keys → sk_test_…
 *   - development:      test keys → sk_test_… in .env.local
 *
 * On first init we log the resolved mode so it surfaces in deploy
 * logs ("[stripe] live mode active" or "[stripe] test mode active").
 * If the resolved mode mismatches the deploy environment (e.g.,
 * production deploy with test keys), we log a loud WARNING — the
 * call still proceeds (operator might be intentionally test-running
 * a single deploy) but the warning shows up in Vercel's runtime logs.
 */

import type Stripe from 'stripe';

let cached: Stripe | null = null;
/** Memoized once the first getStripe() call resolves. Read by
 *  getStripeMode() callers without re-running the prefix check. */
let cachedMode: 'live' | 'test' | null = null;

export type StripeMode = 'live' | 'test';

/** Resolve the active Stripe mode from the secret key prefix. Returns
 *  null when no key is configured (i.e., before getStripe() succeeds).
 *  Callers that need the mode without instantiating the SDK can use
 *  this directly. */
export function getStripeMode(): StripeMode | null {
  if (cachedMode) return cachedMode;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (key.startsWith('sk_live_')) {
    cachedMode = 'live';
    return 'live';
  }
  if (key.startsWith('sk_test_')) {
    cachedMode = 'test';
    return 'test';
  }
  // Restricted keys (rk_live_, rk_test_) follow the same prefix
  // convention. Treat them the same.
  if (key.startsWith('rk_live_')) {
    cachedMode = 'live';
    return 'live';
  }
  if (key.startsWith('rk_test_')) {
    cachedMode = 'test';
    return 'test';
  }
  // Unknown key shape — refuse to guess. Log + return null so the
  // SDK init fails loudly rather than silently calling Stripe with a
  // potentially mis-categorized key.
  console.warn(
    `[stripe] STRIPE_SECRET_KEY has an unrecognized prefix; expected sk_live_/sk_test_/rk_live_/rk_test_`
  );
  return null;
}

/** Returns a singleton Stripe instance, or null if STRIPE_SECRET_KEY
 *  isn't configured. Routes that hit this should 503 with a clear
 *  message when null comes back. */
export async function getStripe(): Promise<Stripe | null> {
  if (cached) return cached;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;

  const mode = getStripeMode();
  if (!mode) return null;

  // Lazy import — keeps the SDK out of bundles where Stripe isn't
  // configured.
  let StripeCtor: typeof import('stripe').default;
  try {
    StripeCtor = (await import('stripe')).default;
  } catch {
    return null;
  }

  cached = new StripeCtor(secretKey);

  // Startup log — surfaces in Vercel runtime logs the first time any
  // route exercises the Stripe path. If the resolved mode doesn't
  // match the deploy environment scope (production-with-test-keys or
  // preview-with-live-keys), warn loudly so the misconfiguration is
  // visible without waiting for a real-money mistake.
  const vercelEnv = process.env.VERCEL_ENV; // 'production' | 'preview' | 'development' | undefined
  const expectedMode: StripeMode | null =
    vercelEnv === 'production' ? 'live' : vercelEnv ? 'test' : null;
  if (expectedMode && mode !== expectedMode) {
    console.warn(
      `[stripe] ⚠ MODE MISMATCH: ${mode} keys configured on ${vercelEnv} deploy. Expected ${expectedMode}. ` +
        `Either intentional (one-off test on a production deploy) or a misconfiguration — verify before processing payments.`
    );
  } else {
    console.log(
      `[stripe] ${mode} mode active${vercelEnv ? ` (${vercelEnv} deploy)` : ''}`
    );
  }

  return cached;
}

/** Helper for routes — produces the canonical 503 error envelope when
 *  Stripe isn't yet configured. Caller should `return` this directly. */
export const STRIPE_NOT_CONFIGURED_ERROR = {
  error:
    'Checkout not yet configured. Set STRIPE_SECRET_KEY in your environment.',
} as const;
