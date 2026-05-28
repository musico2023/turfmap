import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, Crosshair, ShieldCheck, Zap, Clock } from 'lucide-react';
import { ScanIntakeForm } from '@/components/marketing/scan/ScanIntakeForm';
import { finalPriceCents, lookupCoupon } from '@/lib/coupons/knownCoupons';
import { getServerSupabase } from '@/lib/supabase/server';
import type { ProspectRow } from '@/lib/supabase/types';

/**
 * /scan/intake — universal intake-first checkout entry.
 *
 * One intake page, four upstream landers:
 *   - /scan        → cold-Meta paid traffic (MAPCHECK50 → $49)
 *   - /fourdots    → exit-intent popup (FOURDOTS50 → $49)
 *   - /yourmap     → cold-email cohort (MAPCHECK50 or no coupon)
 *   - /freescan    → warm-reactivation cohort (VIP → $0)
 *
 * Whichever lander forwards them in, the page resolves the coupon
 * from the registry to compute the actual price displayed in copy +
 * sub-headline. When a prospect_id is present (/yourmap or /freescan
 * cohort buyers) we look up the prospect row server-side and prefill
 * business name + suggest keyword from trade, so warm/cold cohort
 * buyers see a partially-filled form instead of a blank one.
 *
 * Flow: this page → form submit → POST /api/scan/checkout/init →
 * Stripe Checkout (skipped for $0 if Stripe gates it) → /order/success
 * (auto-fulfill from session metadata) → scan running.
 *
 * The /yourmap COLDSCAN bypass and /yourmap freescan-with-geo path
 * still skip this page — they have their own dedicated one-click
 * routes (/api/yourmap/coldscan-fulfill) where no form is needed
 * because the prospect record holds all the data.
 *
 * noindex/nofollow per the rest of the paid-traffic LPs.
 */

export const metadata: Metadata = {
  title: 'Your TurfScan details · TurfMap',
  description:
    'Five fields, then your scan and fix list. TurfMap geo-grid scan + AI Coach Fix List, delivered in under a minute.',
  robots: { index: false, follow: false },
};

const LIST_CENTS = 9900;

function pickFirst(v: string | string[] | undefined): string | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

/**
 * Look up a cohort prospect by id to prefill the form. Returns null
 * for missing/unknown ids or any lookup error — the form just renders
 * blank in that case. Safe to call on every request (the row read is
 * cheap; the lander hits aren't high volume).
 */
async function prospectPrefill(
  prospectId: string | null
): Promise<{
  businessName: string | null;
  keyword: string | null;
} | null> {
  if (!prospectId) return null;
  try {
    const supabase = getServerSupabase();
    const { data } = await supabase
      .from('prospects')
      .select('business_name, trade')
      .eq('id', prospectId)
      .maybeSingle<Pick<ProspectRow, 'business_name' | 'trade'>>();
    if (!data) return null;
    return {
      businessName: data.business_name ?? null,
      // Trade-as-keyword default — the buyer can edit on the form.
      // Mirrors the same heuristic /api/yourmap/coldscan-fulfill uses.
      keyword: data.trade ?? null,
    };
  } catch {
    return null;
  }
}

export default async function ScanIntakePage({
  searchParams,
}: {
  searchParams: Promise<{
    [key: string]: string | string[] | undefined;
  }>;
}) {
  const params = await searchParams;
  // Coupon is the upstream lander's choice — we DON'T default to
  // MAPCHECK50 anymore. Empty means full $99 list (rare path, but
  // honored). The intake form mirrors whatever the lander said.
  const couponCode = pickFirst(params.coupon);
  const utmSource = pickFirst(params.utm_source);
  const utmMedium = pickFirst(params.utm_medium);
  const utmCampaign = pickFirst(params.utm_campaign);
  const gclid = pickFirst(params.gclid);
  const prospectId = pickFirst(params.prospect_id);
  const cancelled = pickFirst(params.cancelled) === '1';

  // Resolve coupon to final price so the intake form's button label +
  // reassurance copy can adapt (paid vs free). Falls back to list when
  // the code is unknown / tier-mismatched / null.
  const coupon = couponCode ? lookupCoupon(couponCode, 'scan') : null;
  const finalCents = coupon ? finalPriceCents(coupon) : LIST_CENTS;

  // Where does the "Back" link go? Mirror the lander the buyer came
  // from when we can infer it from URL params; default to /scan.
  // Heuristic: COLDSCAN + freescan-style cohort = /freescan, MAPCHECK50
  // with prospect_id = /yourmap, COLDSCAN with prospect_id = /yourmap,
  // FOURDOTS50 = /fourdots, default = /scan.
  const backHref = (() => {
    const c = (couponCode ?? '').toUpperCase();
    if (c === 'VIP') return '/freescan';
    if (c === 'FOURDOTS50') return '/fourdots';
    if (prospectId) return '/yourmap';
    return '/scan';
  })();

  const prefill = await prospectPrefill(prospectId);

  return (
    <div className="min-h-screen w-full text-white flex flex-col">
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
          href={backHref}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors inline-flex items-center gap-1"
        >
          <ArrowLeft size={11} />
          Back
        </Link>
      </nav>

      <main className="flex-1 px-5 md:px-8 py-8 md:py-12">
        <div className="max-w-xl mx-auto">
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
            Five fields; your scan and fix list awaits.
          </p>

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

          <ScanIntakeForm
            coupon={couponCode}
            utmSource={utmSource}
            utmMedium={utmMedium}
            utmCampaign={utmCampaign}
            gclid={gclid}
            prospectId={prospectId}
            finalCents={finalCents}
            prefillBusinessName={prefill?.businessName ?? null}
            prefillKeyword={prefill?.keyword ?? null}
          />

          <div
            className="mt-8 pt-6 border-t"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <ul className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs text-zinc-400">
              <li className="flex items-start gap-2">
                <Zap
                  size={14}
                  className="flex-shrink-0 mt-0.5"
                  style={{ color: 'var(--color-lime)' }}
                />
                <span>Scan fires in under a minute after payment</span>
              </li>
              <li className="flex items-start gap-2">
                <ShieldCheck
                  size={14}
                  className="flex-shrink-0 mt-0.5"
                  style={{ color: 'var(--color-lime)' }}
                />
                <span>Stripe handles the card — we never see it</span>
              </li>
              <li className="flex items-start gap-2">
                <Clock
                  size={14}
                  className="flex-shrink-0 mt-0.5"
                  style={{ color: 'var(--color-lime)' }}
                />
                <span>Full refund within 24h, one-email request</span>
              </li>
            </ul>
          </div>
        </div>
      </main>
    </div>
  );
}
