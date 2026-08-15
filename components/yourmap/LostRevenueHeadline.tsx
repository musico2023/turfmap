/**
 * Dollar-headline block for /yourmap (v2.2 §P0.3).
 *
 * Renders the "estimated $X–$Y/mo lost to <top_competitor>" hero above
 * the map, plus a "how we calculated this" expandable that lists the
 * formula and the public sources for the per-trade job values. The
 * whole idea (v2.2 §P0.1 Appendix): the number must survive a roofer
 * poking at it — the methodology has to be visible on the page.
 *
 * Renders nothing when lost_rev_display is null (legacy pre-2026-07-01
 * prospects that predate lib/lost_rev.py wiring) — /yourmap falls back
 * to the invisibility-count hero copy already in place.
 *
 * Below the block, we surface the canonical case-study line + a
 * deep-link to fourdots.io/home-services per v2.2 §14 item 5.
 */

import type { ReactNode } from 'react';

export type LostRevenueHeadlineProps = {
  businessName: string;
  trade: string;
  lostRevDisplay: string | null;
  lostRevConfidence: string | null;      // "high" | "medium" | "low" | null
  topCompetitorName: string | null;
  invisibilityCount: number;
};

export function LostRevenueHeadline({
  businessName,
  trade,
  lostRevDisplay,
  lostRevConfidence,
  topCompetitorName,
  invisibilityCount,
}: LostRevenueHeadlineProps): ReactNode {
  // Gate: no estimate → render nothing so the page's existing
  // invisibility hero copy remains the primary anchor for legacy rows.
  if (!lostRevDisplay || lostRevDisplay === '$0/mo') {
    return null;
  }

  const competitor = topCompetitorName?.trim() || 'a competitor';
  const isLowConfidence = lostRevConfidence === 'low';
  const tradeLabel = (trade || 'jobs').toLowerCase();

  // Copy is deliberately careful: the word "estimated" always appears,
  // and it's bolder when confidence is low so we don't overstate a
  // fallback number as gospel.
  const estimatedLabel = isLowConfidence ? (
    <span className="uppercase tracking-widest text-[10px] text-[#c5ff3a] font-bold">
      Estimated (low confidence)
    </span>
  ) : (
    <span className="uppercase tracking-widest text-[10px] text-zinc-400">
      Estimated
    </span>
  );

  return (
    <div className="mb-6 rounded-2xl border border-[#27272a] bg-[#0d0d0d] p-6">
      {estimatedLabel}
      <h2 className="mt-2 font-sans text-2xl md:text-3xl leading-snug text-zinc-100">
        {businessName} is losing{' '}
        <span className="text-[#c5ff3a] font-bold">{lostRevDisplay}</span>{' '}
        in {tradeLabel} jobs to {competitor}.
      </h2>

      {/* Methodology expandable — "how we calculated this" — v2.2 §P0.1
       *  Appendix. Uses native <details> so it's server-rendered, works
       *  without JS, and the disclosure state doesn't need a client
       *  component. */}
      <details className="mt-4 group">
        <summary className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-200 select-none">
          How we calculated this <span className="text-zinc-600 group-open:hidden">▾</span><span className="text-zinc-600 hidden group-open:inline">▴</span>
        </summary>

        <div className="mt-3 space-y-3 text-sm text-zinc-400 leading-relaxed">
          <p>
            We estimate the monthly revenue a business in your trade + market
            leaks to the Google local pack when it&rsquo;s invisible across
            {' '}{invisibilityCount}/81 grid cells. The formula is:
          </p>

          <pre className="text-[11px] bg-[#0a0a0a] border border-[#1f1f22] rounded-md p-3 overflow-x-auto text-zinc-300 whitespace-pre">
{`monthly_searches
  × 0.44   (local-pack share of Maps SERP clicks)
  × ${(invisibilityCount / 81).toFixed(2)}   (your invisibility factor: ${invisibilityCount}/81)
  × 0.25   (your fair share of the 3-slot local pack)
  × 0.10   (click-to-lead rate)
  × 0.10-0.15   (lead-to-close rate — deliberately conservative)
  × avg_job_value   (per-trade Canadian residential 2026 average)`}
          </pre>

          <p>
            Job value ranges come from public Canadian residential averages —
            roofing $10K–$16K per replacement (
            <a className="underline hover:text-zinc-200"
               href="https://www.custom-contracting.ca/resources/roofing-cost-ontario"
               target="_blank" rel="noopener">Custom Contracting, 2026</a>),
            HVAC combined install $6.5K–$12.5K (
            <a className="underline hover:text-zinc-200"
               href="https://www.homestars.com/heating/price-guides/hvac-installation-cost"
               target="_blank" rel="noopener">HomeStars, 2026</a>),
            interior painting $2K–$5K / exterior $3K–$8K (
            <a className="underline hover:text-zinc-200"
               href="https://www.homestars.com/painting/price-guides/cost-to-paint-a-house"
               target="_blank" rel="noopener">HomeStars, 2026</a>).
          </p>

          {isLowConfidence && (
            <p className="text-[#ff9f43]">
              <strong>Note:</strong> We don&rsquo;t have direct market search
              volume for your trade × city so we&rsquo;re using a per-trade
              national median. Actual local demand may be higher or lower.
              The order of magnitude is what matters here.
            </p>
          )}
        </div>
      </details>

      {/* Case-study line + deep link — v2.2 §14 item 5. */}
      <div className="mt-5 pt-5 border-t border-[#1f1f22] text-sm text-zinc-400">
        <p>
          <span className="text-zinc-300">
            A national painting franchise we run booked <strong>62 calls</strong>
            {' '}in April with their previous agency, then{' '}
            <strong className="text-[#c5ff3a]">671</strong> the next April with us
          </span>
          {' '}— same budget, same market.{' '}
          <a
            className="underline hover:text-zinc-200"
            href="https://fourdots.io/home-services"
            target="_blank"
            rel="noopener"
          >
            Case study
          </a>
          .
        </p>
      </div>
    </div>
  );
}
