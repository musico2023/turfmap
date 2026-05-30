/**
 * Per-tier configuration for the intake-first checkout flow.
 *
 * The intake page (/intake), the form (ScanIntakeForm), and the init
 * endpoint (/api/scan/checkout/init) all share this table so price,
 * copy, and Stripe price-id env keys stay aligned in one place.
 *
 * Tiers covered:
 *   - scan       — TurfScan $99 one-time
 *   - audit      — Visibility Audit $499 one-time
 *   - strategy   — Strategy Session $1,497 one-time (3-keyword)
 *   - pulse      — Pulse $39/mo or $372/yr (monthly cadence adds a
 *                  required $99 TurfScan setup fee line item)
 *   - pulse_plus — Pulse+ $99/mo or $950/yr (3-keyword; monthly adds
 *                  the same $99 TurfScan setup fee line item)
 *
 * Subscription tiers (pulse / pulse_plus) carry a `cadence` dimension
 * that the init route + intake page resolve via the `cadencePriceEnvKey`
 * + `cadenceListCents` maps below. One-time tiers leave those fields
 * null and use `priceEnvKey` + `listCents` directly.
 */

export const INTAKE_TIERS = [
  'scan',
  'audit',
  'strategy',
  'pulse',
  'pulse_plus',
] as const;
export type IntakeTier = (typeof INTAKE_TIERS)[number];

export const INTAKE_CADENCES = ['monthly', 'annual'] as const;
export type IntakeCadence = (typeof INTAKE_CADENCES)[number];

/** Subset of tiers that go through Stripe in subscription mode. The
 *  rest run in one-time `payment` mode. Centralized here so the init
 *  route + the intake page can branch off the same source of truth. */
export const SUBSCRIPTION_INTAKE_TIERS: ReadonlySet<IntakeTier> = new Set([
  'pulse',
  'pulse_plus',
]);

export function isSubscriptionIntakeTier(tier: IntakeTier): boolean {
  return SUBSCRIPTION_INTAKE_TIERS.has(tier);
}

/** How many keyword inputs the intake form renders for this tier.
 *  Scan / audit / pulse collect 1; strategy + Pulse+ collect 3
 *  (comparative scans across service variations). Mirrors
 *  lib/stripe/leadOrders.keywordCountForTier so the form + the
 *  fulfill route agree on capacity. */
export function keywordsRequiredForTier(tier: IntakeTier): number {
  return tier === 'strategy' || tier === 'pulse_plus' ? 3 : 1;
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
  'pricing',
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
  // Pulse / Pulse+ CTAs anchor the homepage pricing section, so back
  // navigation deposits the buyer at that section rather than the top.
  pricing: { backHref: '/#section-04', backLabel: 'Back to pricing' },
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
  /** Stripe Checkout `mode` for this tier. One-time tiers run
   *  'payment'; recurring tiers run 'subscription'. */
  mode: 'payment' | 'subscription';
  /** List price cents for one-shot tiers (mode === 'payment'). Null
   *  for subscription tiers — read cadenceListCents instead. */
  listCents: number | null;
  /** Stripe price-id env-key for one-shot tiers. Null for
   *  subscription tiers — read cadencePriceEnvKey instead. The init
   *  route reads process.env[priceEnvKey] at request time so deploys
   *  without the Stripe products configured surface a clean 503
   *  instead of silently failing. */
  priceEnvKey: string | null;
  /** Per-cadence price-id env-keys for subscription tiers. Null for
   *  one-shot tiers. */
  cadencePriceEnvKey: Record<IntakeCadence, string> | null;
  /** Per-cadence list price cents for subscription tiers. Monthly is
   *  the per-month price; annual is the per-year total (NOT the
   *  monthly-equivalent — keeps the intake-page price chip honest
   *  about what Stripe charges at checkout). Null for one-shot
   *  tiers. */
  cadenceListCents: Record<IntakeCadence, number> | null;
  /** Whether monthly cadence adds a mandatory $99 TurfScan setup
   *  line item. Pulse + Pulse+ monthly do; annual cadence buyers are
   *  effectively pre-paying it via the annual discount.
   *  Always false for one-shot tiers. The init route reads this and
   *  appends NEXT_PUBLIC_STRIPE_PRICE_SCAN as a second line item
   *  when true. Rationale: /api/checkout/[tier] route doc block. */
  requiresMonthlyScanSetup: boolean;
  /** Hero copy on the intake page — what the buyer is buying. The
   *  generic /scan/intake copy used "Tell us where to scan." which
   *  doesn't fit an audit / Pulse purchase; per-tier hero text owns
   *  it. */
  pageTitle: string;
  /** Sub-line under the hero — orienting language about the form. */
  pageSubtitle: string;
};

export const INTAKE_TIER_CONFIGS: Record<IntakeTier, IntakeTierConfig> = {
  scan: {
    label: 'TurfScan',
    mode: 'payment',
    listCents: 9900,
    priceEnvKey: 'NEXT_PUBLIC_STRIPE_PRICE_SCAN',
    cadencePriceEnvKey: null,
    cadenceListCents: null,
    requiresMonthlyScanSetup: false,
    pageTitle: 'Tell us where to scan.',
    pageSubtitle: 'Five fields away from your scan and fix list.',
  },
  audit: {
    label: 'Visibility Audit',
    mode: 'payment',
    listCents: 49900,
    priceEnvKey: 'NEXT_PUBLIC_STRIPE_PRICE_AUDIT',
    cadencePriceEnvKey: null,
    cadenceListCents: null,
    requiresMonthlyScanSetup: false,
    pageTitle: 'Tell us where to audit.',
    pageSubtitle:
      'Five fields up front — then payment, then your scan + the 90-day Roadmap.',
  },
  strategy: {
    label: 'Strategy Session',
    mode: 'payment',
    listCents: 149700,
    priceEnvKey: 'NEXT_PUBLIC_STRIPE_PRICE_STRATEGY',
    cadencePriceEnvKey: null,
    cadenceListCents: null,
    requiresMonthlyScanSetup: false,
    pageTitle: 'Tell us where to scan, three ways.',
    pageSubtitle:
      'Seven fields — three keywords so we can compare your visibility across service angles before the 90-minute strategy session.',
  },
  pulse: {
    label: 'Pulse',
    mode: 'subscription',
    listCents: null,
    priceEnvKey: null,
    cadencePriceEnvKey: {
      monthly: 'NEXT_PUBLIC_STRIPE_PRICE_PULSE_MONTHLY',
      annual: 'NEXT_PUBLIC_STRIPE_PRICE_PULSE_ANNUAL',
    },
    cadenceListCents: {
      // Per-month and per-year totals (NOT annual-as-monthly-equivalent).
      monthly: 3900,
      annual: 37200,
    },
    requiresMonthlyScanSetup: true,
    pageTitle: 'Tell us where to start Pulse.',
    pageSubtitle:
      'Five fields, then weekly scans + monthly score-movement alerts kick off automatically.',
  },
  pulse_plus: {
    label: 'Pulse+',
    mode: 'subscription',
    listCents: null,
    priceEnvKey: null,
    cadencePriceEnvKey: {
      monthly: 'NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_MONTHLY',
      annual: 'NEXT_PUBLIC_STRIPE_PRICE_PULSEPLUS_ANNUAL',
    },
    cadenceListCents: {
      monthly: 9900,
      annual: 95000,
    },
    requiresMonthlyScanSetup: true,
    pageTitle: 'Tell us where to start Pulse+.',
    pageSubtitle:
      'Seven fields — three keywords so weekly scans + citation building start the moment you check out.',
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

/** Type-guard for the cadence param. Subscription tiers default to
 *  'monthly' when missing (preserves back-compat with marketing CTAs
 *  that haven't yet adopted the toggle). One-time tiers ignore the
 *  cadence entirely. */
export function asIntakeCadence(value: unknown): IntakeCadence | null {
  if (typeof value !== 'string') return null;
  return (INTAKE_CADENCES as readonly string[]).includes(value)
    ? (value as IntakeCadence)
    : null;
}

/** Resolve the Stripe price-id env-key for a (tier, cadence) tuple.
 *  Returns null when the tier doesn't recognize the cadence shape
 *  (e.g. cadence on a one-time tier — never expected to happen at
 *  the call site; defensive only). */
export function resolveIntakePriceEnvKey(
  tier: IntakeTier,
  cadence: IntakeCadence
): string | null {
  const config = INTAKE_TIER_CONFIGS[tier];
  if (config.mode === 'payment') return config.priceEnvKey;
  return config.cadencePriceEnvKey?.[cadence] ?? null;
}

/** Resolve the list price cents for a (tier, cadence) tuple. Used by
 *  the intake page's pricing chip + the form's button label. Returns
 *  null when neither the one-shot listCents nor the cadenceListCents
 *  map covers the call — should not happen for any registered tier. */
export function resolveIntakeListCents(
  tier: IntakeTier,
  cadence: IntakeCadence
): number | null {
  const config = INTAKE_TIER_CONFIGS[tier];
  if (config.mode === 'payment') return config.listCents;
  return config.cadenceListCents?.[cadence] ?? null;
}
