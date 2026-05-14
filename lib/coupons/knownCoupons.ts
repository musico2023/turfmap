/**
 * Known landing-page coupons.
 *
 * Each entry binds a customer-facing coupon code (the string that
 * appears in URLs from popups, ad creatives, etc.) to:
 *   - the discount math we render on-page (so the lander shows the
 *     right strikethrough + final price without round-tripping to
 *     Stripe before the buyer even hits "Buy")
 *   - the tier the coupon is valid for (we ignore mismatched coupons
 *     so a `tier=audit&coupon=FOURDOTS50` URL doesn't show a bogus
 *     $50-off-on-$499 page)
 *
 * Coupon codes are case-insensitive at lookup time but stored
 * uppercase here for readability. The actual Stripe-side coupon /
 * promotion-code object is created in the Stripe dashboard — this
 * map is purely client-rendering metadata; the API forwards the
 * raw code string to Stripe at checkout-session-create time and
 * lets Stripe validate it.
 */

export type CouponDescriptor = {
  /** Customer-facing code as it appears in URLs / popups. */
  code: string;
  /** Which tier this coupon applies to. Mismatched URLs render full price. */
  validForTier: 'scan' | 'audit' | 'strategy' | 'pulse' | 'pulse_plus';
  /** Full list price in cents (pre-discount). */
  listPriceCents: number;
  /** Discount amount in cents — flat-amount coupons only for now. */
  discountCents: number;
  /**
   * Source of the coupon code on the Stripe side. Stripe Coupons have
   * an internal id; Promotion Codes are the customer-facing wrappers.
   * The API tries both at checkout-session-create time so this is
   * informational. Most landing-page coupons are Promotion Codes
   * (customer-readable string IDs) attached to a Coupon.
   */
  stripeKind: 'coupon' | 'promotion_code';
  /** Short label for the offer — rendered on the lander. */
  label: string;
};

const COUPONS: Record<string, CouponDescriptor> = {
  FOURDOTS50: {
    code: 'FOURDOTS50',
    validForTier: 'scan',
    listPriceCents: 9900,
    discountCents: 5000,
    stripeKind: 'promotion_code',
    label: '$50 off',
  },
  // MAPCHECK50 — cold-email cohort coupon for /yourmap traffic.
  // Same discount math as FOURDOTS50 ($99 → $49) but a different
  // code so we can attribute conversions per acquisition channel.
  // Stripe-side promotion code MUST exist before traffic arrives;
  // operator creates it in the Stripe dashboard.
  MAPCHECK50: {
    code: 'MAPCHECK50',
    validForTier: 'scan',
    listPriceCents: 9900,
    discountCents: 5000,
    stripeKind: 'promotion_code',
    label: '$50 off',
  },
};

/**
 * Look up a coupon by raw code. Case-insensitive. Returns null when
 * the code is unknown or doesn't match the requested tier — the
 * caller should fall back to full-price rendering rather than show
 * an invalid offer.
 */
export function lookupCoupon(
  code: string | null | undefined,
  tier: CouponDescriptor['validForTier']
): CouponDescriptor | null {
  if (!code) return null;
  const entry = COUPONS[code.trim().toUpperCase()];
  if (!entry) return null;
  if (entry.validForTier !== tier) return null;
  return entry;
}

/** Final price in cents after applying a coupon. Floored at 0 in
 *  case a future coupon is misconfigured to discount more than the
 *  list price. */
export function finalPriceCents(coupon: CouponDescriptor): number {
  return Math.max(0, coupon.listPriceCents - coupon.discountCents);
}

/** USD-formatted dollar amount from cents (no decimals when whole). */
export function formatUsd(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars)
    ? `$${dollars}`
    : `$${dollars.toFixed(2)}`;
}
