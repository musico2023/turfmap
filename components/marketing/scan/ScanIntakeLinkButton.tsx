'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { trackMetaEvent } from '@/components/marketing/scan/MetaPixel';

/**
 * Drop-in replacement for ScanCheckoutButton on the /scan cold-Meta
 * lander.
 *
 * Difference: this button does NOT POST to Stripe directly. It
 * navigates the buyer to /scan/intake (the form page) with all
 * attribution params preserved in the URL. Stripe Checkout fires
 * later, from the intake form submit, via /api/scan/checkout/init.
 *
 * Visually + behaviorally identical from the buyer's perspective:
 * same lime button, same label prop, same centered/helperText
 * affordances as ScanCheckoutButton. Only the destination differs.
 *
 * Tracking: fires a custom Meta `ScanCtaClick` event on click.
 * InitiateCheckout has been moved to the intake-form submit, since
 * that's where the actual Stripe Checkout flow now begins.
 */

export type ScanIntakeLinkButtonProps = {
  coupon?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  /** Per-ad-variant identifier — typically set in the Meta ad URL
   *  params field with the {{ad.name}} dynamic placeholder. Forwarded
   *  through to Stripe metadata so we can read which creative variant
   *  drove a conversion. */
  utmContent?: string | null;
  /** Audience / keyword bucket — less critical than utm_content but
   *  cheap to forward when Meta/Google sets it. */
  utmTerm?: string | null;
  /** Google Ads click id. */
  gclid?: string | null;
  /** Meta click id — auto-appended by Facebook/Instagram to ad
   *  destinations. Equivalent of gclid for Meta. Used by Meta's
   *  Conversion API to deduplicate server-side events against pixel
   *  events. */
  fbclid?: string | null;
  /** Cold/warm cohort prospect id from /yourmap or /freescan. When
   *  set, the intake page looks up the prospect record and pre-fills
   *  business_name + suggests address/keyword from city + trade. */
  prospectId?: string | null;
  /** Visible CTA text. Same semantics as ScanCheckoutButton.label. */
  label: string;
  /** Center the button + helper line — matches
   *  ScanCheckoutButton.centered for visual parity on closing-CTA
   *  panels. */
  centered?: boolean;
  /** Helper-text variants per scroll position:
   *    undefined  → default click-flow line
   *    null       → hide
   *    string     → custom (e.g. "$49 charged once. Refund within 24h.") */
  helperText?: string | null;
};

export function ScanIntakeLinkButton({
  coupon,
  utmSource,
  utmMedium,
  utmCampaign,
  utmContent,
  utmTerm,
  gclid,
  fbclid,
  prospectId,
  label,
  centered = false,
  helperText,
}: ScanIntakeLinkButtonProps) {
  // Build the /scan/intake URL preserving all attribution params so
  // the intake form (and downstream Stripe metadata) carry the
  // source/cohort identifiers through to the conversion.
  const params = new URLSearchParams();
  if (coupon) params.set('coupon', coupon);
  if (utmSource) params.set('utm_source', utmSource);
  if (utmMedium) params.set('utm_medium', utmMedium);
  if (utmCampaign) params.set('utm_campaign', utmCampaign);
  if (utmContent) params.set('utm_content', utmContent);
  if (utmTerm) params.set('utm_term', utmTerm);
  if (gclid) params.set('gclid', gclid);
  if (fbclid) params.set('fbclid', fbclid);
  if (prospectId) params.set('prospect_id', prospectId);
  const href = `/scan/intake${params.toString() ? `?${params}` : ''}`;

  const onClick = () => {
    // Mid-funnel intent signal — buyer expressed buy interest, hasn't
    // committed yet. Meta logs this as a custom event under the same
    // pixel. Distinct from InitiateCheckout (now fires at form submit).
    trackMetaEvent('ScanCtaClick', {
      content_name: 'TurfScan',
      content_category: 'lander_cta',
      coupon: coupon ?? undefined,
      utm_source: utmSource ?? undefined,
      utm_medium: utmMedium ?? undefined,
      utm_campaign: utmCampaign ?? undefined,
    });
  };

  return (
    <div
      className={
        centered
          ? 'flex flex-col items-center gap-2.5'
          : 'flex flex-col items-stretch gap-2.5'
      }
    >
      <Link
        href={href}
        onClick={onClick}
        className="inline-flex items-center justify-center gap-2 px-5 py-3.5 md:py-4 rounded-md font-bold text-base md:text-lg transition-all hover:brightness-110 w-full"
        style={{
          background: 'var(--color-lime)',
          color: 'black',
          boxShadow: '0 6px 20px rgba(197, 255, 58, 0.30)',
          minHeight: 56,
        }}
      >
        {label}
        <ArrowRight size={16} strokeWidth={2.5} />
      </Link>
      {helperText !== null && (
        <p
          className={`text-xs text-zinc-500 leading-relaxed ${
            centered ? 'text-center' : ''
          }`}
        >
          {helperText === undefined ? (
            <>
              Next: business details{' '}
              <span className="text-zinc-600">→</span> secure Stripe checkout{' '}
              <span className="text-zinc-600">→</span> scan fires immediately.
            </>
          ) : (
            helperText
          )}
        </p>
      )}
    </div>
  );
}
