import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, Crosshair, ShieldCheck, Zap, Clock } from 'lucide-react';
import { ScanIntakeForm } from '@/components/marketing/scan/ScanIntakeForm';

/**
 * /scan/intake — intake-first checkout entry for the cold-Meta funnel.
 *
 * Sits between the /scan lander and Stripe Checkout:
 *   /scan -> click "Run my scan" -> /scan/intake (this page) ->
 *   form submit -> /api/scan/checkout/init -> Stripe -> /order/success
 *   (auto-fulfill from session metadata) -> scan running.
 *
 * Why intake-first (vs the legacy Stripe-first flow used by /fourdots
 * + /yourmap): buyers who've already filled the form are far less
 * likely to abandon at the payment step. The post-payment-form
 * abandonment hole on /order/success closes too — all fields land on
 * Stripe metadata before the buyer ever sees the Stripe page.
 *
 * Attribution: utm_*, gclid, coupon all forwarded from /scan via URL
 * params and stamped onto Stripe metadata at session-create time so
 * the cold-Meta funnel attribution doesn't break.
 *
 * Coupon: MAPCHECK50 hardcoded — /scan is a single-purpose lander.
 * The URL still respects ?coupon= for one-off operator testing.
 *
 * noindex/nofollow per the rest of the paid-traffic LPs.
 */

export const metadata: Metadata = {
  title: 'Your TurfScan details — $49 with MAPCHECK50 · TurfMap',
  description:
    'Enter your business details so your TurfMap scan runs against the right address + keyword. Secure Stripe checkout follows.',
  robots: { index: false, follow: false },
};

const DEFAULT_UTM_SOURCE = 'meta_cold';
const DEFAULT_UTM_MEDIUM = 'paid_social';
const DEFAULT_COUPON = 'MAPCHECK50';

function pickFirst(v: string | string[] | undefined): string | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

export default async function ScanIntakePage({
  searchParams,
}: {
  searchParams: Promise<{
    [key: string]: string | string[] | undefined;
  }>;
}) {
  const params = await searchParams;
  const coupon = pickFirst(params.coupon) ?? DEFAULT_COUPON;
  const utmSource = pickFirst(params.utm_source) ?? DEFAULT_UTM_SOURCE;
  const utmMedium = pickFirst(params.utm_medium) ?? DEFAULT_UTM_MEDIUM;
  const utmCampaign = pickFirst(params.utm_campaign);
  const gclid = pickFirst(params.gclid);
  const cancelled = pickFirst(params.cancelled) === '1';

  return (
    <div className="min-h-screen w-full text-white flex flex-col">
      {/* Top nav strip — brand mark + a discreet "back to scan" link.
       *  No sign-in CTA (cold-Meta paid lander rules: don't pull
       *  attention away from the buy decision). */}
      <nav
        className="border-b px-4 md:px-6 py-3 flex items-center justify-between"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="w-7 h-7 rounded flex items-center justify-center"
            style={{
              background: 'var(--color-lime)',
              boxShadow: '0 0 16px #c5ff3a30',
            }}
          >
            <Crosshair size={14} className="text-black" strokeWidth={2.75} />
          </div>
          <span className="font-display text-base font-bold">TurfMap.ai</span>
        </div>
        <Link
          href="/scan"
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors inline-flex items-center gap-1"
        >
          <ArrowLeft size={11} />
          Back
        </Link>
      </nav>

      <main className="flex-1 px-5 md:px-8 py-8 md:py-12">
        <div className="max-w-xl mx-auto">
          {/* Section eyebrow + heading — sets context that this is
           *  the pre-payment step. */}
          <div
            className="text-[11px] uppercase tracking-[0.22em] font-mono font-semibold mb-3"
            style={{ color: 'var(--color-lime)' }}
          >
            Step 1 of 2 · Your scan details
          </div>
          <h1 className="font-display text-2xl md:text-3xl font-black leading-tight tracking-tight mb-2 text-zinc-50">
            Tell us where to scan.
          </h1>
          <p className="text-sm md:text-base text-zinc-400 leading-relaxed mb-6">
            Five fields. Secure Stripe checkout follows — $49 once with
            MAPCHECK50 auto-applied. Scan fires the moment payment clears.
          </p>

          {/* Cancelled-from-Stripe return banner. Cosmetic — the form
           *  is preserved either way (browser autofill picks back up
           *  the typed values on most stacks). */}
          {cancelled && (
            <div
              className="rounded-md border px-4 py-3 mb-5 text-xs leading-relaxed"
              style={{
                background: '#1a1308',
                borderColor: '#3a2a0a',
                color: '#f5b651',
              }}
              role="status"
            >
              Checkout was cancelled. No charge was made — fix anything you
              want to change and re-submit when ready.
            </div>
          )}

          {/* The actual form (client component). Submit -> POST
           *  /api/scan/checkout/init -> redirect to Stripe. */}
          <ScanIntakeForm
            coupon={coupon}
            utmSource={utmSource}
            utmMedium={utmMedium}
            utmCampaign={utmCampaign}
            gclid={gclid}
          />

          {/* Reassurance strip below the form — three small icons +
           *  short text. Echoes the /scan trust strip but framed
           *  around the moment-of-payment specifically. */}
          <div className="mt-8 pt-6 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <ul className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs text-zinc-400">
              <li className="flex items-start gap-2">
                <Zap size={14} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--color-lime)' }} />
                <span>Scan fires in under a minute after payment</span>
              </li>
              <li className="flex items-start gap-2">
                <ShieldCheck size={14} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--color-lime)' }} />
                <span>Stripe handles the card — we never see it</span>
              </li>
              <li className="flex items-start gap-2">
                <Clock size={14} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--color-lime)' }} />
                <span>Full refund within 24h, one-email request</span>
              </li>
            </ul>
          </div>
        </div>
      </main>
    </div>
  );
}
