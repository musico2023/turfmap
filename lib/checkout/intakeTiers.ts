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

export const INTAKE_TIERS = ['scan', 'audit', 'strategy'] as const;
export type IntakeTier = (typeof INTAKE_TIERS)[number];

/** How many keyword inputs the intake form renders for this tier.
 *  Scan + audit collect 1; strategy collects 3 (comparative
 *  scans across service variations). */
export function keywordsRequiredForTier(tier: IntakeTier): number {
  return tier === 'strategy' ? 3 : 1;
}

// ── Intake source ────────────────────────────────────────────────────
//
// The /intake page is a shared destination across several landers +
// the homepage. The "Back" link needs to send the buyer back where
// they came from — not always /scan, which is what the previous
// coupon/prospect heuristic defaulted to (and which made the homepage
// flow feel broken).
//
// Each CTA passes ?from=<source> explicitly when it links to /intake;
// the page maps that source to { backHref, backLabel }. When the param
// is missing, we fall back to 'home' so direct traffic and stale
// bookmarks end up on the homepage, not a lander they've never seen.

export const INTAKE_SOURCES = [
  'home',
  'scan',
  'yourmap',
  'freescan',
  'fourdots',
] as const;
export type IntakeSource = (typeof INTAKE_SOURCES)[number];

export type IntakeSourceConfig = {
  backHref: string;
  backLabel: string;
};

export const INTAKE_SOURCE_CONFIGS: Record<IntakeSource, IntakeSourceConfig> = {
  home: { backHref: '/', backLabel: 'Back to homepage' },
  scan: { backHref: '/scan', backLabel: 'Back to TurfScan' },
  yourmap: { backHref: '/yourmap', backLabel: 'Back to your map' },
  freescan: { backHref: '/freescan', backLabel: 'Back to free scan' },
  fourdots: { backHref: '/fourdots', backLabel: 'Back to Fourdots' },
};

/** Default source when the inbound URL doesn't declare one. Homepage
 *  is the safe fallback — never send a buyer to a lander they didn't
 *  come from. */
export const DEFAULT_INTAKE_SOURCE: IntakeSource = 'home';

export function asIntakeSource(value: unknown): IntakeSource | null {
  if (typeof value !== 'string') return null;
  return (INTAKE_SOURCES as readonly string[]).includes(value)
    ? (value as IntakeSource)
    : null;
}

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
};

export const INTAKE_TIER_CONFIGS: Record<IntakeTier, IntakeTierConfig> = {
  scan: {
    label: 'TurfScan',
    listCents: 9900,
    priceEnvKey: 'NEXT_PUBLIC_STRIPE_PRICE_SCAN',
    pageTitle: 'Tell us where to scan.',
    pageSubtitle: 'Five fields away from your scan and fix list.',
  },
  audit: {
    label: 'Visibility Audit',
    listCents: 49900,
    priceEnvKey: 'NEXT_PUBLIC_STRIPE_PRICE_AUDIT',
    pageTitle: 'Tell us where to audit.',
    pageSubtitle:
      'Five fields up front — then payment, then your scan + the 90-day Roadmap.',
  },
  strategy: {
    label: 'Strategy Session',
    listCents: 149700,
    priceEnvKey: 'NEXT_PUBLIC_STRIPE_PRICE_STRATEGY',
    pageTitle: 'Tell us where to scan, three ways.',
    pageSubtitle:
      'Seven fields — three keywords so we can compare your visibility across service angles before the 90-minute strategy session.',
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
