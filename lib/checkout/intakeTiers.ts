/**
 * Per-tier configuration for the intake-first checkout flow.
 *
 * The intake page (/intake), the form (ScanIntakeForm), and the init
 * endpoint (/api/scan/checkout/init) all share this table so price,
 * copy, and Stripe price-id env keys stay aligned in one place.
 *
 * Tiers covered: scan (TurfScan $99) + audit (Visibility Audit $499).
 * Strategy is intentionally NOT supported here yet — its intake needs
 * 3 keyword inputs + Cal.com booking handoff that the current single-
 * keyword form doesn't yet collect. Strategy buyers stay on the
 * legacy Stripe-first flow at /api/checkout/strategy until that
 * intake variant lands.
 */

export const INTAKE_TIERS = ['scan', 'audit'] as const;
export type IntakeTier = (typeof INTAKE_TIERS)[number];

export type IntakeTierConfig = {
  /** UI tier label shown in the step header + sub-header chip. */
  label: string;
  /** List price cents — what the buyer sees when no coupon applies.
   *  Coupon-driven discounting overrides this on a per-coupon basis
   *  (the existing knownCoupons.finalPriceCents pipeline). */
  listCents: number;
  /** Stripe price-id env var. The init route reads
   *  process.env[priceEnvKey] at request time so deploys without the
   *  Stripe products configured surface a clean 503 instead of
   *  silently failing. */
  priceEnvKey: string;
  /** Hero copy on the intake page — what the buyer is buying. The
   *  generic /scan/intake copy used "Tell us where to scan." which
   *  doesn't fit an audit purchase; per-tier hero text owns it. */
  pageTitle: string;
  /** Sub-line under the hero — orienting language about the form. */
  pageSubtitle: string;
  /** Where the "Back" link returns to when the buyer doesn't carry a
   *  coupon / prospect_id hint. Scan defaults to /scan (the lander);
   *  audit defaults to / (the homepage pricing surface). */
  defaultBackHref: string;
};

export const INTAKE_TIER_CONFIGS: Record<IntakeTier, IntakeTierConfig> = {
  scan: {
    label: 'TurfScan',
    listCents: 9900,
    priceEnvKey: 'NEXT_PUBLIC_STRIPE_PRICE_SCAN',
    pageTitle: 'Tell us where to scan.',
    pageSubtitle: 'Five fields away from your scan and fix list.',
    defaultBackHref: '/scan',
  },
  audit: {
    label: 'Visibility Audit',
    listCents: 49900,
    priceEnvKey: 'NEXT_PUBLIC_STRIPE_PRICE_AUDIT',
    pageTitle: 'Tell us where to audit.',
    pageSubtitle:
      'Five fields up front — then payment, then your scan + the 90-day Roadmap.',
    defaultBackHref: '/',
  },
};

/** Type-guard helper for callers reading tier from untrusted input
 *  (URL params, request bodies). Returns null when the value isn't a
 *  recognized intake tier. */
export function asIntakeTier(value: unknown): IntakeTier | null {
  if (typeof value !== 'string') return null;
  return (INTAKE_TIERS as readonly string[]).includes(value)
    ? (value as IntakeTier)
    : null;
}
