import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, Crosshair, ShieldCheck, Zap, Clock } from 'lucide-react';
import { ScanIntakeForm } from '@/components/marketing/scan/ScanIntakeForm';
import { finalPriceCents, lookupCoupon } from '@/lib/coupons/knownCoupons';
import {
  asIntakeSource,
  asIntakeTier,
  DEFAULT_INTAKE_SOURCE,
  INTAKE_SOURCE_CONFIGS,
  INTAKE_TIER_CONFIGS,
  type IntakeTier,
} from '@/lib/checkout/intakeTiers';
import { getServerSupabase } from '@/lib/supabase/server';
import type { ProspectRow } from '@/lib/supabase/types';

/**
 * /intake — universal intake-first checkout entry, tier-aware.
 *
 * Replaces the old single-tier /scan/intake (which now 308-redirects
 * here with ?tier=scan). One page, two tiers:
 *
 *   ?tier=scan   → TurfScan ($99 list, coupon-aware: MAPCHECK50,
 *                  FOURDOTS50, COLDSCAN, VIP → $49 / $0)
 *   ?tier=audit  → Visibility Audit ($499, no coupon path yet)
 *
 * Upstream entry points:
 *   - homepage TurfScan card     → /intake?tier=scan
 *   - homepage Audit card        → /intake?tier=audit
 *   - /scan (cold-Meta)          → /intake?tier=scan&coupon=MAPCHECK50…
 *   - /fourdots, /yourmap,       → /intake?tier=scan&coupon=…&prospect_id=…
 *     /freescan
 *
 * Strategy tier ($1,497) is NOT routed through this page — its
 * 3-keyword + Cal.com booking intake is a separate sprint. Strategy
 * buyers still hit /api/checkout/strategy directly.
 *
 * Flow: this page → form submit → POST /api/scan/checkout/init →
 * Stripe Checkout → /order/success (auto-fulfill from session
 * metadata) → scan running / audit dashboard.
 *
 * noindex/nofollow per the rest of the conversion surfaces.
 */

export const metadata: Metadata = {
  title: 'Your order details · TurfMap',
  description:
    'Five fields, then your TurfMap is ready. Geo-grid scan, AI Coach Fix List, delivered in under a minute.',
  robots: { index: false, follow: false },
};

function pickFirst(v: string | string[] | undefined): string | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

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
      keyword: data.trade ?? null,
    };
  } catch {
    return null;
  }
}

export default async function IntakePage({
  searchParams,
}: {
  searchParams: Promise<{
    [key: string]: string | string[] | undefined;
  }>;
}) {
  const params = await searchParams;

  // Tier resolution — defaults to scan when missing/unknown so any
  // legacy link that hits /intake without a tier still lands somewhere
  // sane. The init route re-validates server-side so we don't need to
  // 404 here on bad input.
  const tier: IntakeTier =
    asIntakeTier(pickFirst(params.tier)) ?? 'scan';
  const tierConfig = INTAKE_TIER_CONFIGS[tier];

  const couponCode = pickFirst(params.coupon);
  const utmSource = pickFirst(params.utm_source);
  const utmMedium = pickFirst(params.utm_medium);
  const utmCampaign = pickFirst(params.utm_campaign);
  const utmContent = pickFirst(params.utm_content);
  const utmTerm = pickFirst(params.utm_term);
  const gclid = pickFirst(params.gclid);
  const fbclid = pickFirst(params.fbclid);
  const prospectId = pickFirst(params.prospect_id);
  const cancelled = pickFirst(params.cancelled) === '1';

  // Cart-recovery resume prefill. The abandonment emails (see the
  // checkout.session.expired webhook) deep-link here with the buyer's
  // own business name + keyword in the query string so they land on a
  // pre-filled form. These take precedence over the prospect-table
  // prefill below — they're the buyer's actual intake input, not a
  // cold-outreach guess.
  const prefillBusinessParam = pickFirst(params.prefill_business);
  const prefillKeywordParam = pickFirst(params.prefill_keyword);

  // Coupon registry currently only registers scan-tier discounts. For
  // audit we skip the lookup and use the list price — no audit coupons
  // are wired yet. When that lands, swap the second arg to `tier`.
  const coupon =
    tier === 'scan' && couponCode
      ? lookupCoupon(couponCode, 'scan')
      : null;
  const finalCents = coupon ? finalPriceCents(coupon) : tierConfig.listCents;

  // Back-link is driven by an explicit ?from=<source> the upstream CTA
  // declares. Falls back to 'home' when missing so direct/bookmark
  // traffic never lands on a lander they didn't come from. The previous
  // coupon-based heuristic mis-routed homepage TurfScan buyers to /scan
  // because they had no coupon/prospect signal at all.
  const fromSource =
    asIntakeSource(pickFirst(params.from)) ?? DEFAULT_INTAKE_SOURCE;
  const sourceConfig = INTAKE_SOURCE_CONFIGS[fromSource];

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
          href={sourceConfig.backHref}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors inline-flex items-center gap-1"
        >
          <ArrowLeft size={11} />
          {sourceConfig.backLabel}
        </Link>
      </nav>

      <main className="flex-1 px-5 md:px-8 py-8 md:py-12">
        <div className="max-w-xl mx-auto">
          <div
            className="text-[11px] uppercase tracking-[0.22em] font-mono font-semibold mb-3"
            style={{ color: 'var(--color-lime)' }}
          >
            Step 1 of 2 · {tierConfig.label} details
          </div>
          <h1 className="font-display text-2xl md:text-3xl font-black leading-tight tracking-tight mb-2 text-zinc-50">
            {tierConfig.pageTitle}
          </h1>
          <p className="text-sm md:text-base text-zinc-400 leading-relaxed mb-6">
            {tierConfig.pageSubtitle}
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
            tier={tier}
            coupon={couponCode}
            utmSource={utmSource}
            utmMedium={utmMedium}
            utmCampaign={utmCampaign}
            utmContent={utmContent}
            utmTerm={utmTerm}
            gclid={gclid}
            fbclid={fbclid}
            prospectId={prospectId}
            finalCents={finalCents}
            prefillBusinessName={
              prefillBusinessParam ?? prefill?.businessName ?? null
            }
            prefillKeyword={prefillKeywordParam ?? prefill?.keyword ?? null}
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
                <span>
                  {tier === 'audit'
                    ? 'Scan + Roadmap delivered within 48h'
                    : 'Scan fires in under a minute after payment'}
                </span>
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
