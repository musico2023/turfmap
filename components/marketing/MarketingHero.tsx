'use client';

import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { HeatmapGrid } from '@/components/turfmap/HeatmapGrid';
import { LinkButton } from '@/components/ui/Button';
import { buildHeroCells, HERO_METRICS } from './heroSeed';

/**
 * Rotating vertical labels for the hero eyebrow. Cycles every
 * ROTATE_MS ms with a CSS opacity fade so the swap doesn't yank the
 * reader's eye. Container width is fixed (see minWidth below) so
 * the longest label doesn't shift the layout when shorter labels
 * render.
 */
const ROTATING_LABELS = [
  'BUSINESSES',
  'PLUMBERS',
  'ROOFERS',
  'CLINICS',
  'CONTRACTORS',
  'RESTAURANTS',
  'CLEANERS',
  'DENTISTS',
  'HVAC PROS',
  'LANDSCAPERS',
] as const;
const ROTATE_MS = 2500;
const FADE_MS = 350;

function RotatingLabel() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => {
      setIdx((i) => (i + 1) % ROTATING_LABELS.length);
    }, ROTATE_MS);
    return () => window.clearInterval(t);
  }, []);
  // Cross-fade implementation. All labels are stacked absolutely
  // inside an inline-block container; the active one is at opacity 1
  // and the rest at 0, both transitioning over FADE_MS. At any moment
  // during a swap, the outgoing label is fading 1→0 *while* the
  // incoming is fading 0→1 — there is never a frame where no label
  // is rendered. Replaces the prior single-span fade-out / swap /
  // fade-in approach which had a ~FADE_MS window with the eyebrow
  // reading "...local · from $99" with the vertical missing.
  //
  // Container needs explicit height + line-height:1 because absolute
  // children don't contribute to the inline-block's layout box; the
  // 1em / lh:1 keeps the eyebrow vertically aligned with the
  // surrounding "Google Maps audit for local … · from $99" text.
  // Layout strategy: an invisible "ghost" of the longest label sits
  // in normal flow inside the container. The ghost gives the
  // container its width AND its line-box — so the container inherits
  // the same line-height + half-leading the surrounding eyebrow
  // text uses. Without the ghost, an empty inline-block has no inline
  // content, defaults to height:1em with no half-leading, and its
  // baseline falls ~1px above the surrounding text's baseline (the
  // bug the user reported: lime text rendered visibly higher than
  // the gray text around it).
  //
  // The active label sits over the ghost as an absolute child with
  // inset:0 — same width AND height as the ghost, so its line-box
  // matches the ghost's line-box exactly. With identical font,
  // font-size, and line-height, the glyphs land in the same vertical
  // position as the ghost's would, keeping every label visually
  // co-baselined with the surrounding "Google Maps audit for local
  // … · from $99" text.
  //
  // Pick the widest label deterministically rather than hard-coding
  // 'LANDSCAPERS' — protects against future label edits that swap
  // the longest entry.
  const widestLabel = ROTATING_LABELS.reduce(
    (a, b) => (b.length > a.length ? b : a),
    ROTATING_LABELS[0]
  );
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-block',
        textAlign: 'left',
      }}
      aria-live="polite"
    >
      {/* Width + line-box anchor. Visibility:hidden keeps it taking
       *  layout space without rendering, so the container size +
       *  baseline track the surrounding text exactly. */}
      <span style={{ visibility: 'hidden' }} aria-hidden>
        {widestLabel}
      </span>
      {ROTATING_LABELS.map((label, i) => (
        <span
          key={label}
          aria-hidden={i !== idx}
          style={{
            position: 'absolute',
            inset: 0,
            color: 'var(--color-lime)',
            opacity: i === idx ? 1 : 0,
            transition: `opacity ${FADE_MS}ms ease-in-out`,
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
      ))}
    </span>
  );
}

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
            Google Maps audit for local <RotatingLabel /> · from $99
          </div>
          {/* Type scale dropped one tier (was 5xl/6xl/7xl) after the
           *  H1 copy got longer — the prior scale wrapped to 4 lines on
           *  desktop and pushed everything else below the fold. 4xl/
           *  5xl/6xl keeps the headline weight without crowding the
           *  sub-line + CTAs. */}
          <h1 className="font-display text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.05] mb-4">
            See how much of your city <em>can&rsquo;t find</em>{' '}your
            business.
          </h1>
          {/* Positioning sub-headline — sits between H1 and the descriptive
           *  subhead. Italic to flag it as the strategic frame ("what is
           *  this product, in one line?") rather than a continuation of
           *  the description. */}
          <p className="font-display text-xl md:text-2xl text-zinc-300 italic leading-snug mb-8 max-w-xl">
            We run{' '}
            <strong className="font-semibold text-zinc-100">
              81 real Google searches
            </strong>{' '}
            across your service area and show you, cell by cell, where
            you show up — and where a competitor is taking the call.
            Most local businesses are invisible to{' '}
            <strong className="font-semibold text-zinc-100">
              two-thirds
            </strong>{' '}
            of the people searching nearby.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <LinkButton
              variant="primary"
              size="lg"
              href="#section-04"
              rightIcon={<ArrowRight size={16} strokeWidth={2.5} />}
            >
              Order your TurfMap audit
            </LinkButton>
            {/* Secondary CTA bumped one step brighter than the default
             *  `secondary` variant so it reads as a real button on the
             *  hero's bare-page surface (var(--color-bg) #0a0a0a). The
             *  default secondary uses var(--color-card) #0d0d0d which
             *  almost disappears against the hero. We bump the bg one
             *  shade up + thicken the border + lighten its color so
             *  the edge is legible — but keep the lime CTA visually
             *  dominant (no background fill change, no font weight
             *  bump). Other secondary CTAs across the site are sitting
             *  on already-tinted card surfaces so they don't need the
             *  override. */}
            <LinkButton
              variant="secondary"
              size="lg"
              href="#section-02"
              style={{
                background: '#161616',
                borderColor: '#3f3f46',
                borderWidth: '2px',
              }}
            >
              How it works
            </LinkButton>
          </div>
          <div className="mt-7 flex items-center gap-5 text-xs text-zinc-500 font-mono">
            <span className="flex items-center gap-1.5">
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: 'var(--color-lime)' }}
              />
              Delivered in under a minute
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
      {/* Score names render as written (PascalCase, no space) — no
       *  CSS uppercase transform. Matches the dashboard StatCard
       *  treatment so "TurfScore™" reads identically across the
       *  marketing hero and the in-app score cards. Other in-page
       *  labels (column headers, tier eyebrows) keep their uppercase
       *  styling — this is specific to the proper-noun score family. */}
      <div className="text-[10px] tracking-tight text-zinc-400 font-semibold">
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
