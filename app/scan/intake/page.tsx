import { redirect, permanentRedirect } from 'next/navigation';

/**
 * /scan/intake — legacy redirect to /intake.
 *
 * Original tier-locked intake page lived here. Now tier-aware at
 * /intake (one page handles scan + audit). This shim preserves any
 * inbound link that still points at /scan/intake — landers, Meta ad
 * destination URLs, email campaigns — by 308-redirecting to the new
 * canonical route with tier=scan pinned.
 *
 * Preserves all query parameters so coupon, prospect_id, utm_*, and
 * gclid/fbclid carry through to /intake unchanged.
 *
 * Uses `permanentRedirect` so search engines de-list /scan/intake;
 * both pages are noindex anyway, but the 308 ensures the legacy URL
 * fully drops from any external indexes that crept through.
 */

export const dynamic = 'force-dynamic';

export default async function LegacyScanIntakeRedirect({
  searchParams,
}: {
  searchParams: Promise<{
    [key: string]: string | string[] | undefined;
  }>;
}) {
  const params = await searchParams;
  const out = new URLSearchParams();
  out.set('tier', 'scan');
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((vv) => out.append(k, vv));
    else out.set(k, v);
  }
  // Belt-and-suspenders: if the inbound URL already carried tier, the
  // for-loop above overwrites our default. That's intentional — a
  // forward-compat caller can specify a different tier.
  const target = `/intake?${out.toString()}`;
  // permanentRedirect uses 308 which preserves method (legacy GETs,
  // future POSTs alike). redirect() throws a 307 redirect signal.
  permanentRedirect(target);
  // Unreachable — present only to satisfy TS's "must return" rule
  // since permanentRedirect's TypeScript signature isn't `never`.
  redirect(target);
}
