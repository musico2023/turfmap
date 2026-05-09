/**
 * GET /api/dev/stripe-mode
 *
 * Operator-side health check that returns which Stripe mode the
 * current deploy is running in (live vs. test) and whether that
 * mode matches the deploy's environment scope.
 *
 * Useful for confirming the per-environment env-var setup is
 * correct after wiring up the test-mode preview pattern. Hit this
 * on production (should return mode=live) and on a preview URL
 * (should return mode=test) to validate.
 *
 * Gated to fourdots-domain agency emails — internal-only.
 */

import { NextResponse } from 'next/server';
import { isAgencyOwnerEmail, requireAgencyUserForApi } from '@/lib/auth/agency';
import { getStripeMode } from '@/lib/stripe/client';

export const runtime = 'nodejs';

export async function GET() {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  if (!isAgencyOwnerEmail(auth.email)) {
    return NextResponse.json(
      { error: 'fourdots-only' },
      { status: 403 }
    );
  }

  const mode = getStripeMode();
  const vercelEnv = process.env.VERCEL_ENV ?? null;
  const expectedMode: 'live' | 'test' | null =
    vercelEnv === 'production'
      ? 'live'
      : vercelEnv === 'preview' || vercelEnv === 'development'
        ? 'test'
        : null;
  const mismatch = mode != null && expectedMode != null && mode !== expectedMode;

  return NextResponse.json({
    mode,
    vercel_env: vercelEnv,
    expected_mode: expectedMode,
    mismatch,
    note: mismatch
      ? `⚠ MODE MISMATCH: this ${vercelEnv} deploy is configured with ${mode} keys, expected ${expectedMode}.`
      : mode == null
        ? 'STRIPE_SECRET_KEY not set or has unrecognized prefix.'
        : `OK: ${mode} keys correctly configured for ${vercelEnv ?? 'unknown'} environment.`,
  });
}
