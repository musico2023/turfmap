/**
 * Cal.com booking-URL helpers.
 *
 * Audit + Strategy tiers promise a strategist call as part of the
 * deliverable. Cal.com hosts the calendar UI; we just hand the buyer
 * a pre-filled URL pointing at the right event type.
 *
 * Env vars (production + preview, set by operator in Vercel):
 *   CAL_COM_AUDIT_URL     — base URL for the 30-min Audit walkthrough
 *                            event, e.g.
 *                            https://cal.com/anthony-fourdots/audit-walkthrough
 *   CAL_COM_STRATEGY_URL  — base URL for the 90-min Strategy session
 *                            event.
 *
 * These are public URLs (no secrets). They could live in
 * NEXT_PUBLIC_* env if we wanted client-side access without an extra
 * API hit, but keeping them server-side means we don't expose them
 * to non-Audit/Strategy buyers in the bundle.
 *
 * Pre-fill: Cal.com supports `?email=X&name=Y&notes=Z` query params
 * on event URLs to pre-populate the booking form. We pass through
 * what we know at order-fulfill time so the buyer doesn't retype.
 */

import type { Tier } from '@/lib/supabase/types';

/** Build a buyer-specific Cal.com booking URL for the strategist
 *  call tied to this tier. Returns null when the tier doesn't
 *  include a strategist call (Pulse / Pulse+ / Scan) OR when the
 *  relevant env var isn't set yet (graceful pre-launch behavior).
 */
export function calcomBookingUrlForTier(args: {
  tier: Tier;
  email: string;
  businessName: string;
}): string | null {
  const baseUrl = baseCalcomUrlForTier(args.tier);
  if (!baseUrl) return null;
  const params = new URLSearchParams({
    email: args.email,
    name: args.businessName,
    // notes pre-fills the "Additional notes" field on the booking
    // form — gives the strategist immediate context on whose
    // territory they're walking through.
    notes: `Booking from TurfMap ${tierLabel(args.tier)} order for ${args.businessName}.`,
  });
  return `${baseUrl}?${params.toString()}`;
}

function baseCalcomUrlForTier(tier: Tier): string | null {
  if (tier === 'audit') return process.env.CAL_COM_AUDIT_URL ?? null;
  if (tier === 'strategy') return process.env.CAL_COM_STRATEGY_URL ?? null;
  return null;
}

function tierLabel(tier: Tier): string {
  if (tier === 'audit') return 'Visibility Audit';
  if (tier === 'strategy') return 'Strategy Session';
  return tier;
}
