/**
 * /yourmap/print/[prospect_id] — 8.5"×11" print-styled whale letter (v2.2 §P0.7).
 *
 * This route renders a single letter-sized page suitable for capture by
 * a headless-Chromium screenshot at 300dpi (see
 * scripts/render_whale_heatmap.py in the Lead Gen repo). The captured
 * PNG feeds Postalytics — either as the value of a `var_field_N` merge
 * variable (Path A per v2.2 §9.1) or as the `front` image URL on a
 * per-recipient template create (Path B). Both paths use the same
 * screenshot; the difference is composition on Postalytics's side.
 *
 * Design:
 *   - Fixed dimensions: 8.5"×11" @ 96 DPI = 816×1056 CSS pixels. A print
 *     viewport of 2550×3300 at 300dpi captures at that ratio.
 *   - Dark theme (#0a0a0a bg) mirrors the /yourmap look. Whales who
 *     scan the PURL land on the same brand.
 *   - NO client-side interactivity. NO CTAs. This is a static asset.
 *   - Cells arranged in a 9×9 grid; red X on invisible cells, brand
 *     lime for #1-ranked cells (rare — most whale letters go to buyers
 *     with high invisibility). The competitor-color-on-dominance
 *     variant is deferred to a follow-up (needs per-cell competitor
 *     data we don't currently persist).
 *
 * Auth: no gating. This route is public because the screenshot script
 * has to be able to hit it without auth headers. Prospect data
 * exposure risk is bounded by prospect_id being a 10-char nanoid
 * (~60 bits of entropy) — a scraper can't enumerate.
 *
 * Not this route:
 *   - Prospect intent tracking. This is a rendering surface, not a
 *     funnel touchpoint. If someone actually views this URL in a
 *     browser (rare), don't fire scan_viewed — the pathname
 *     differentiates.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getServerSupabase } from '@/lib/supabase/server';
import { HeatmapGrid } from '@/components/turfmap/HeatmapGrid';
import { buildRepresentativeCells } from '@/components/marketing/representativeHeatmap';
import type { ProspectRow } from '@/lib/supabase/types';

// Static export off — we always need fresh prospect data.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'TurfMap — Whale Letter Print View',
  robots: { index: false, follow: false },
};

export default async function Page(
  { params }: { params: Promise<{ prospect_id: string }> }
) {
  const { prospect_id } = await params;
  const supabase = getServerSupabase();
  const { data: prospect } = await supabase
    .from('prospects')
    .select('*')
    .eq('id', prospect_id)
    .maybeSingle<ProspectRow>();

  if (!prospect) notFound();

  const cells = buildRepresentativeCells(prospect.id, prospect.invisibility_count);
  const competitor = prospect.top_competitor_name?.trim() || 'a competitor';
  const dollarLine = prospect.lost_rev_display
    ? `Est. ${prospect.lost_rev_display} in ${(prospect.trade || 'jobs').toLowerCase()} jobs routing to ${competitor}`
    : `${prospect.invisibility_count}/81 search zones going to ${competitor}`;

  return (
    <>
      {/* Reset the page to letter-size, no margins, hide all site chrome.
       *  The <style> element is scoped to this route via Next's file
       *  routing — no leakage to the rest of the app. */}
      <style>{`
        html, body {
          margin: 0 !important;
          padding: 0 !important;
          background: #0a0a0a !important;
          color: #f4f4f5 !important;
          font-family: system-ui, -apple-system, "Segoe UI", sans-serif !important;
        }
        /* Hide any global layout chrome that might sneak in — the print
         * layout owns the viewport 100%. Next's route groups usually
         * prevent this, but we're extra explicit here for
         * screenshot-fidelity insurance. */
        nav, header, footer { display: none !important; }
        @page { size: letter; margin: 0; }
        @media print { html, body { print-color-adjust: exact; } }
        .print-page {
          width: 816px;
          min-height: 1056px;
          padding: 56px;
          box-sizing: border-box;
          background: #0a0a0a;
        }
      `}</style>

      <div className="print-page">
        {/* Top strip: brand + business name + city */}
        <div style={{ display: 'flex', justifyContent: 'space-between',
                       alignItems: 'baseline', marginBottom: 20 }}>
          <div style={{ fontSize: 12, letterSpacing: '0.18em',
                         textTransform: 'uppercase', color: '#c5ff3a',
                         fontWeight: 700 }}>
            TurfMap · Fourdots
          </div>
          <div style={{ fontSize: 11, color: '#71717a' }}>
            9×9 Grid · {prospect.city}
          </div>
        </div>

        {/* Dollar headline */}
        <h1 style={{ fontSize: 28, lineHeight: 1.15, fontWeight: 700,
                      color: '#f4f4f5', margin: '0 0 12px 0' }}>
          {prospect.business_name}
        </h1>
        <p style={{ fontSize: 16, lineHeight: 1.35, color: '#e4e4e7',
                     margin: '0 0 24px 0' }}>
          {dollarLine}
        </p>

        {/* Grid — dead center */}
        <div style={{ display: 'flex', justifyContent: 'center',
                       margin: '24px 0 32px 0' }}>
          <HeatmapGrid
            cells={cells}
            animateReveal={false}
            revealMsPerDist={0}
          />
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', gap: 18, justifyContent: 'center',
                       marginBottom: 32, fontSize: 11, color: '#a1a1aa' }}>
          <span><span style={{ display: 'inline-block', width: 10, height: 10,
                                background: '#c5ff3a', marginRight: 6 }} />
                #1 in local pack</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10,
                                background: '#e8e54a', marginRight: 6 }} />
                #2</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10,
                                background: '#ff9f3a', marginRight: 6 }} />
                #3</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10,
                                background: '#ff4d4d', marginRight: 6 }} />
                not visible ({prospect.invisibility_count}/81)</span>
        </div>

        {/* 3 fixes block */}
        <div style={{ borderTop: '1px solid #27272a', paddingTop: 20 }}>
          <h2 style={{ fontSize: 14, textTransform: 'uppercase',
                        letterSpacing: '0.14em', color: '#c5ff3a',
                        margin: '0 0 12px 0', fontWeight: 700 }}>
            Three fixes we&rsquo;d start with
          </h2>
          <ol style={{ paddingLeft: 20, margin: 0, color: '#d4d4d8',
                       fontSize: 13, lineHeight: 1.55 }}>
            <li style={{ marginBottom: 8 }}>
              <strong style={{ color: '#f4f4f5' }}>Reset your GBP primary category</strong>
              {' — '}the current label is generic; the buyer-intent variant for {prospect.trade || 'your trade'} shifts ranking in ~30 days.
            </li>
            <li style={{ marginBottom: 8 }}>
              <strong style={{ color: '#f4f4f5' }}>Rebuild citation NAP consistency</strong>
              {' — '}your name+address disagree across major directories. Google reads that as low trust.
            </li>
            <li style={{ marginBottom: 8 }}>
              <strong style={{ color: '#f4f4f5' }}>Turn on review-velocity cadence</strong>
              {' — '}{competitor} is asking every job. You&rsquo;re asking none. This is the ranking gap in your dark cells.
            </li>
          </ol>
        </div>

        {/* Footer: reply channel + PURL note. */}
        <div style={{ marginTop: 32, borderTop: '1px solid #27272a',
                       paddingTop: 20, fontSize: 12, color: '#a1a1aa' }}>
          <div style={{ marginBottom: 6 }}>
            <strong style={{ color: '#f4f4f5' }}>Anthony Alfonsi</strong>
            {' · Director, Fourdots Digital · '}
            <span style={{ color: '#c5ff3a' }}>call/text me — number redacted for the print scaffold</span>
          </div>
          <div>
            Scan the QR to see the live interactive map + full fix list.
          </div>
        </div>
      </div>
    </>
  );
}
