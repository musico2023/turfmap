'use client';

import { useState } from 'react';
import { ArrowRight, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ScanProgress } from '@/components/turfmap/ScanProgress';

export type ColdscanRunButtonProps = {
  /** Cold-email cohort prospect id (10-char nanoid). Required — the
   *  whole bypass is keyed off this. */
  prospectId: string;
  /** Attribution params forwarded to lead_orders.stripe_metadata so
   *  the coldscan_free conversions still attach to the source campaign
   *  for reporting. Each is independently optional. */
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  /** Visible CTA label. Caller-controlled so the lander can match the
   *  surrounding copy ("Run my free TurfScan"). */
  label: string;
  /** Centered layout for the closing-CTA panel — same affordance as
   *  ScanCheckoutButton.centered. Default false. */
  centered?: boolean;
};

/**
 * One-click free-TurfScan trigger for the COLDSCAN cold-email cohort.
 *
 * Replaces the Stripe-checkout CTA on /yourmap when the visitor
 * arrives with a valid prospect_id, coupon=COLDSCAN, and the prospect
 * has geo backfilled by the lead-gen pipeline. Skips the entire
 * Stripe Checkout flow and the post-purchase intake form — POSTs to
 * /api/yourmap/coldscan-fulfill which creates the client + scan
 * directly, then redirects the buyer to the resulting share link.
 *
 * UX during the wait: the route awaits the scan synchronously
 * (~30-60s typical). We render <ScanProgress /> as a full overlay
 * during the request so the buyer sees motion + rotating phrases,
 * not a frozen spinner.
 *
 * Error path: surfaces the API error message inline below the button
 * + offers a retry. No silent failure.
 *
 * Why client-side not a <form> action: needs the loading overlay +
 * client-side redirect on success. Server actions could do this but
 * the API-route + fetch pattern matches ScanCheckoutButton, keeps the
 * route reusable from other surfaces (e.g. operator manual trigger),
 * and surfaces JSON errors cleanly.
 */
export function ColdscanRunButton({
  prospectId,
  utmSource,
  utmMedium,
  utmCampaign,
  label,
  centered = false,
}: ColdscanRunButtonProps) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    setError(null);
    setRunning(true);
    try {
      const res = await fetch('/api/yourmap/coldscan-fulfill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prospect_id: prospectId,
          utm_source: utmSource ?? null,
          utm_medium: utmMedium ?? null,
          utm_campaign: utmCampaign ?? null,
        }),
      });
      const data = (await res.json()) as {
        share_url?: string;
        error?: string;
      };
      if (!res.ok || !data.share_url) {
        setRunning(false);
        setError(
          data.error ??
            "We couldn't run your scan — try refreshing, or email anthony@fourdots.io and we'll fire it manually."
        );
        return;
      }
      // Hard navigation so the share page loads fresh (and the URL
      // changes in the address bar, which client-side router.push
      // also does — but assigning window.location is more reliable
      // when the destination is a different route segment).
      window.location.assign(data.share_url);
    } catch (e) {
      setRunning(false);
      setError(
        e instanceof Error
          ? `Network error: ${e.message}`
          : "We couldn't reach the scan service. Try again, or email anthony@fourdots.io."
      );
    }
  };

  return (
    <>
      <div
        className={
          centered
            ? 'flex flex-col items-center gap-2.5'
            : 'flex flex-col items-stretch gap-2.5'
        }
      >
        <Button
          variant="primary"
          size="lg"
          onClick={onClick}
          loading={running}
          loadingLabel="Starting your scan…"
          rightIcon={<ArrowRight size={16} strokeWidth={2.5} />}
        >
          {label}
        </Button>
        <p
          className={`text-[11px] text-zinc-500 leading-relaxed ${
            centered ? 'text-center max-w-sm' : ''
          }`}
        >
          One click. Your scan runs in
          ~30-60 seconds and we&rsquo;ll show your TurfMap as soon as
          it&rsquo;s done.
        </p>
        {error && (
          <p
            className="text-xs leading-relaxed flex items-start gap-1.5"
            style={{ color: '#f5b651' }}
          >
            <AlertCircle
              size={13}
              strokeWidth={2.25}
              className="flex-shrink-0 mt-0.5"
            />
            <span>{error}</span>
          </p>
        )}
      </div>
      {running && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-6"
          style={{ background: 'rgba(10, 10, 10, 0.92)' }}
          aria-live="polite"
          aria-busy="true"
        >
          <div className="max-w-md w-full">
            <ScanProgress />
          </div>
        </div>
      )}
    </>
  );
}
