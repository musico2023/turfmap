'use client';

import { ArrowRight } from 'lucide-react';
import { HeatmapGrid } from '@/components/turfmap/HeatmapGrid';
import { LinkButton } from '@/components/ui/Button';
import { buildHeroCells, HERO_METRICS } from './heroSeed';

/**
 * Landing-page hero.
 *
 * Two-column layout: copy + dual CTA on the left, animated heatmap +
 * inline metrics readout on the right. Stacks on mobile.
 *
 * The heatmap is the SAME `HeatmapGrid` component the live product
 * renders — same cells, same reveal-from-center animation, same
 * color tiers. This is a deliberate signal to the visitor that the
 * marketing page isn't a static brochure: it's the actual instrument
 * they'll be using if they buy.
 *
 * Hero metrics card mirrors the dashboard's stat cards (lime numerals,
 * mono band label, terminal-density type scale) so the page reads as
 * "this is a screenshot of the product" rather than "this is what
 * the product might look like."
 */
export function MarketingHero() {
  const cells = buildHeroCells();
  const { reach, rank, score, band } = HERO_METRICS;

  return (
    <section className="relative pt-28 md:pt-36 pb-20 md:pb-28 px-6 md:px-12 overflow-hidden">
      {/* Subtle radial lime glow centered behind the heatmap — mirrors
       *  the in-app TurfScore card's lime accent without painting the
       *  whole hero. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 60% 50% at 75% 40%, #c5ff3a14 0%, transparent 60%)',
        }}
      />

      <div className="relative max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
        {/* Left: copy + CTAs */}
        <div className="lg:col-span-7">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-5">
            <span style={{ color: 'var(--color-lime)' }}>●</span>{' '}
            Geo-grid SEO diagnostic · from $99
          </div>
          <h1 className="font-display text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.02] mb-6">
            See exactly where you <em>win</em>{' '}— and where you{' '}
            <em>don&rsquo;t.</em>
          </h1>
          <p className="text-zinc-300 text-lg md:text-xl leading-relaxed max-w-xl mb-8">
            TurfMap runs an 81-point geo-grid scan across your service area and
            shows you, cell by cell, where you appear in Google&rsquo;s local
            3-pack. Most local businesses are invisible to two-thirds
            of the people searching for them. Find out what your map looks
            like.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <LinkButton
              variant="primary"
              size="lg"
              href="#section-05"
              rightIcon={<ArrowRight size={16} strokeWidth={2.5} />}
            >
              Order your TurfMap audit
            </LinkButton>
            <LinkButton variant="secondary" size="lg" href="#section-02">
              How it works
            </LinkButton>
          </div>
          <div className="mt-7 flex items-center gap-5 text-xs text-zinc-500 font-mono">
            <span className="flex items-center gap-1.5">
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: 'var(--color-lime)' }}
              />
              Delivered in seconds
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: 'var(--color-lime)' }}
              />
              No commitment
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: 'var(--color-lime)' }}
              />
              81 real searches
            </span>
          </div>
        </div>

        {/* Right: animated heatmap + inline score readout */}
        <div className="lg:col-span-5">
          <div
            className="border rounded-lg p-5 relative"
            style={{
              background: 'var(--color-card)',
              borderColor: 'var(--color-border-bright)',
              boxShadow: '0 0 60px #c5ff3a10',
            }}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
                Sample · Plumber, midtown
              </div>
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500">
                <span
                  className="w-1.5 h-1.5 rounded-full animate-pulse"
                  style={{ background: 'var(--color-lime)' }}
                />
                LIVE
              </div>
            </div>
            <HeatmapGrid cells={cells} />
            <div className="mt-4 grid grid-cols-3 gap-3 text-center">
              <ScoreReadout label="TurfReach™" value={`${reach}%`} />
              <ScoreReadout label="TurfRank™" value={`${rank.toFixed(1)} / 3`} />
              <ScoreReadout
                label="TurfScore™"
                value={String(score)}
                highlight
                bandLabel={band}
              />
            </div>
          </div>
          <p className="text-[11px] text-zinc-600 font-mono mt-2 text-center">
            Anonymized — your map will look different.
          </p>
        </div>
      </div>
    </section>
  );
}

function ScoreReadout({
  label,
  value,
  highlight = false,
  bandLabel,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  bandLabel?: string;
}) {
  return (
    <div
      className="border rounded-md py-2 px-1.5"
      style={{
        background: highlight ? 'var(--color-card-glow)' : 'var(--color-bg)',
        borderColor: highlight
          ? 'var(--color-border-bright)'
          : 'var(--color-border)',
      }}
    >
      <div className="text-[9px] uppercase tracking-wider text-zinc-500 font-semibold">
        {label}
      </div>
      <div
        className="font-display text-2xl font-bold leading-none mt-1"
        style={{ color: highlight ? 'var(--color-lime)' : 'white' }}
      >
        {value}
      </div>
      {bandLabel && (
        <div
          className="text-[10px] font-mono uppercase mt-0.5"
          style={{ color: '#ff9f3a' }}
        >
          {bandLabel}
        </div>
      )}
    </div>
  );
}
