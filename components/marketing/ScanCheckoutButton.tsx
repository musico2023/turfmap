'use client';

import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export type ScanCheckoutButtonProps = {
  /** Pre-resolved coupon code (FOURDOTS50, etc.) to forward to Stripe.
   *  Null when the lander loaded without a coupon param — checkout
   *  proceeds at full list price. */
  coupon?: string | null;
  /** Attribution params, all forwarded to Stripe metadata so the
   *  conversion attaches to the source campaign in the dashboard +
   *  webhook payload. Each is independently optional. */
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  gclid?: string | null;
  /** Visible CTA text. Caller-controlled so the lander can render
   *  the offer math inline ("Get my $49 TurfScan →"). */
  label: string;
  /** Optional Stripe Customer reference id. Currently unused — wired
   *  up here so future flows (e.g. logged-in upgrade) can pass it. */
  clientReferenceId?: string | null;
};

/**
 * Single-purpose CTA button for the /scan exit-intent lander.
 *
 * Bundles: loading state, attribution-aware checkout-API call, GA4
 * `begin_checkout` event firing, and a graceful error fallback that
 * surfaces the Stripe error message inline so the buyer doesn't hit
 * a dead end.
 *
 * Why this is separate from PricingCards' inline checkout: that
 * component renders 3 cards in a row with shared loading state +
 * tier-specific bullets. The lander only sells one tier and shows
 * the discount math directly in the heading — so the affordance
 * here is just "fire the checkout for this single SKU with the
 * pre-resolved coupon attached." Reusing PricingCards would mean
 * threading coupon/utm props through a multi-tier component for
 * what's effectively a one-button page.
 */
export function ScanCheckoutButton({
  coupon,
  utmSource,
  utmMedium,
  utmCampaign,
  gclid,
  label,
  clientReferenceId,
}: ScanCheckoutButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);

    // Fire GA4 begin_checkout *before* the redirect so the event
    // lands even if the buyer abandons on the Stripe page. gtag
    // may be undefined in dev (NEXT_PUBLIC_GA_ID="") — guard the
    // call instead of pulling the lib dependency in.
    type GtagFn = (...args: unknown[]) => void;
    const w = window as unknown as { gtag?: GtagFn };
    if (typeof w.gtag === 'function') {
      w.gtag('event', 'begin_checkout', {
        currency: 'USD',
        items: [{ item_id: 'scan', item_name: 'TurfScan', quantity: 1 }],
        // Coupon + campaign attribution attach to the GA event so the
        // funnel in GA4 can be sliced by source.
        coupon: coupon ?? undefined,
        utm_source: utmSource ?? undefined,
        utm_medium: utmMedium ?? undefined,
        utm_campaign: utmCampaign ?? undefined,
      });
    }

    // Build the API URL with all the attribution params. The server
    // forwards them onto Stripe `metadata` + uses `coupon` to apply
    // a discount via the Promotion Code / Coupon API.
    const params = new URLSearchParams();
    if (coupon) params.set('coupon', coupon);
    if (utmSource) params.set('utm_source', utmSource);
    if (utmMedium) params.set('utm_medium', utmMedium);
    if (utmCampaign) params.set('utm_campaign', utmCampaign);
    if (gclid) params.set('gclid', gclid);
    if (clientReferenceId) params.set('client_reference_id', clientReferenceId);
    const qs = params.toString();
    const apiUrl = `/api/checkout/scan${qs ? `?${qs}` : ''}`;

    try {
      const res = await fetch(apiUrl, { method: 'POST' });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? `Checkout failed (${res.status})`);
        setLoading(false);
        return;
      }
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
      setLoading(false);
    }
  };

  return (
    <div>
      <Button
        type="button"
        variant="primary"
        size="lg"
        onClick={handleClick}
        disabled={loading}
        rightIcon={<ArrowRight size={16} strokeWidth={2.5} />}
        className="w-full sm:w-auto"
      >
        {loading ? 'Opening secure checkout…' : label}
      </Button>
      {error && (
        <p
          className="mt-3 text-xs text-red-400 leading-relaxed"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}
