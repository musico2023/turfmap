import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowDown,
  Check,
  Crosshair,
  Crown,
  Lock,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { ScanIntakeForm } from '@/components/marketing/scan/ScanIntakeForm';
import { HeatmapGrid, type HeatmapCell } from '@/components/turfmap/HeatmapGrid';
import { MetaPixelScrollDepth } from '@/components/marketing/scan/MetaPixel';
import { LoomWalkthrough } from '@/components/marketing/scan/LoomWalkthrough';
import { StickyFreeScoreBar } from '@/components/marketing/scan/StickyFreeScoreBar';

/**
 * Cold-Meta paid-traffic landing page (/prove-it).
 *
 * Sister page to /free-score. Same free-TurfScore funnel and the
 * same downstream MAPCHECK50 unlock on /share — what differs is
 * the emotional axis of the hero. /free-score sells LOSS
 * ("competitors stealing from you"); /prove-it sells EGO ("Think
 * you're #1? Prove it."). Matched to Meta creative #2 which is a
 * trade-personalized typographic dare:
 *
 *   "Think you're the #1 ROOFER in your city? PROVE IT."
 *
 * The trade is a URL param (?trade=roofer|plumber|hvac|painter|...)
 * so a single landing page can satisfy ad-set-level trade
 * targeting — one creative per trade pointing at
 * /prove-it?trade=<slug>. Slugs are validated against an explicit
 * map; unknown values fall back to a generic "#1 in your city"
 * hero so the page never breaks on a typo'd URL.
 *
 * leadSource='prove_it' qualifies this cohort for the discounted
 * unlock — see lib/score/leadSources.ts for the canonical set.
 *
 * Turnstile: previewMode on ScanIntakeForm renders the Turnstile
 * widget automatically when NEXT_PUBLIC_TURNSTILE_SITEKEY is set
 * in the env; preview-init verifies the token server-side. No
 * additional wiring needed here — same setup as /score and
 * /free-score.
 *
 * URL contract:
 *   /prove-it                          — bare visit, generic hero
 *   /prove-it?trade=roofer             — personalized trade
 *   /prove-it?utm_source=meta&utm_*=…  — Meta-ad attribution;
 *                                         forwarded to preview-init
 *                                         and stamped on the
 *                                         resulting client.
 *   /prove-it?fbclid=…                 — auto-appended by Meta on
 *                                         ad clicks; carries through
 *                                         for Conversion API dedup.
 */

export const metadata: Metadata = {
  title: "Think you're the #1 in your city? Prove it. — TurfMap",
  description:
    'Free TurfScore in 60 seconds. See whether you actually rank #1 in your service area — or where your competitors are taking the calls instead. No card.',
  // Paid-traffic LP — same noindex treatment as /scan and /free-score.
  robots: { index: false, follow: false },
};

// Force dynamic — ScanIntakeForm pulls Mapbox's AddressAutofill
// which references `document` at module-eval time and breaks
// static prerender. Same fix as /score and /free-score.
export const dynamic = 'force-dynamic';

const DEFAULT_UTM_SOURCE = 'meta_cold';
const DEFAULT_UTM_MEDIUM = 'paid_social';

function pickFirst(v: string | string[] | undefined): string | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

// ─── Trade personalization map ────────────────────────────────────────
//
// Explicit allow-list of trade slugs the H1 can render. Validating
// against this map (rather than trusting the URL freeform) does two
// jobs: (1) prevents XSS via reflected ?trade= input, (2) lets us
// pick a clean display form for compound trades like "garage-door"
// that don't have an obvious uppercase form.
//
// Adding a new trade? Pick a stable slug, add an entry below, and
// the Meta ad can point at /prove-it?trade=<slug>.

const TRADE_DISPLAY: Record<string, string> = {
  roofer: 'ROOFER',
  roofing: 'ROOFER',
  plumber: 'PLUMBER',
  plumbing: 'PLUMBER',
  // HVAC renders as "HVAC PRO" to match the Meta creative copy.
  // Aliased on `hvac-pro` for explicit URL clarity.
  hvac: 'HVAC PRO',
  'hvac-pro': 'HVAC PRO',
  painter: 'PAINTER',
  painting: 'PAINTER',
  electrician: 'ELECTRICIAN',
  chiropractor: 'CHIROPRACTOR',
  landscaper: 'LANDSCAPER',
  landscaping: 'LANDSCAPER',
  'garage-door': 'GARAGE DOOR INSTALLER',
  'pest-control': 'PEST CONTROL OPERATOR',
  contractor: 'CONTRACTOR',
  cleaner: 'CLEANING OPERATOR',
  cleaning: 'CLEANING OPERATOR',
  dentist: 'DENTIST',
  lawyer: 'LAWYER',
};

function resolveTradeDisplay(slug: string | null): string | null {
  if (!slug) return null;
  const normalized = slug.toLowerCase().trim();
  return TRADE_DISPLAY[normalized] ?? null;
}

// ─── Stylized THEM vs YOU split heatmap data ─────────────────────────
//
// Two hand-tuned 9×9 patterns reused across /free-score and /prove-it
// — same visual vocabulary. THEM = competitor with strong territory
// dominance (mostly rank-1/2). YOU = pre-optimization position.

const THEM_PATTERN = [
  '111122211',
  '111122223',
  '111111223',
  '111111122',
  '111111112',
  '111111122',
  '111111223',
  '111122223',
  '111122211',
] as const;

const YOU_PATTERN = [
  '.........',
  '...3.....',
  '....3....',
  '...3.....',
  '....2.3..',
  '...3.....',
  '....3....',
  '...3.....',
  '.........',
] as const;

function patternToCells(pattern: readonly string[]): HeatmapCell[] {
  const cells: HeatmapCell[] = [];
  for (let y = 0; y < 9; y++) {
    const row = pattern[y];
    for (let x = 0; x < 9; x++) {
      const ch = row[x] ?? '.';
      const rank = ch === '1' || ch === '2' || ch === '3' ? Number(ch) : null;
      cells.push({ x, y, rank });
    }
  }
  return cells;
}

export default async function ProveItLanderPage({
  searchParams,
}: {
  searchParams: Promise<{
    [key: string]: string | string[] | undefined;
  }>;
}) {
  const params = await searchParams;
  const tradeSlug = pickFirst(params.trade);
  const tradeDisplay = resolveTradeDisplay(tradeSlug);
  const utmSource = pickFirst(params.utm_source) ?? DEFAULT_UTM_SOURCE;
  const utmMedium = pickFirst(params.utm_medium) ?? DEFAULT_UTM_MEDIUM;
  const utmCampaign = pickFirst(params.utm_campaign);
  const utmContent = pickFirst(params.utm_content);
  const utmTerm = pickFirst(params.utm_term);
  const gclid = pickFirst(params.gclid);
  const fbclid = pickFirst(params.fbclid);

  const themCells = patternToCells(THEM_PATTERN);
  const youCells = patternToCells(YOU_PATTERN);

  return (
    <div className="min-h-screen w-full text-white">
      {/* Meta pixel engagement signal — fires at 50% scroll depth. */}
      <MetaPixelScrollDepth percent={50} event="ViewContent" />

      {/* Mobile-only sticky bottom bar — slides up once the hero CTA
       *  scrolls off-screen, slides back down once the form section
       *  enters view. Sentinel ids are referenced below.
       *
       *  Label override: "Run my proof" keeps the dare-axis vocabulary
       *  consistent with the hero's "Run my proof — free" button. */}
      <StickyFreeScoreBar
        heroSentinelId="prove-it-sticky-sentinel"
        formAnchorId="prove-it-form"
        buttonLabel="Run my proof"
      />

      {/* ─── Top nav strip ─────────────────────────────────────────── */}
      <nav
        className="border-b px-4 md:px-6 py-3 flex items-center"
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
      </nav>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 01 — Hero (typographic dare, matches Meta creative #2)          */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {/*
       *  Heavy typographic treatment that mirrors the ad's stacked
       *  layout — "Think you're the / #1 [TRADE] / in your city? /
       *  PROVE IT." Each line on its own row, with the trade in lime
       *  and "PROVE IT." in italic white at the heaviest weight.
       *
       *  When ?trade= is missing or unknown, the trade line is
       *  silently dropped — the hero still reads cleanly as
       *  "Think you're #1 in your city? Prove it." */}
      <section className="px-5 md:px-8 pt-8 pb-10 md:pt-14 md:pb-16">
        <div className="max-w-3xl mx-auto text-center md:text-left">
          {/* Eyebrow */}
          <div
            className="text-[11px] uppercase tracking-[0.22em] font-mono font-semibold mb-6"
            style={{ color: 'var(--color-lime)' }}
          >
            Free TurfScore · 60 seconds
          </div>

          {/* H1 — typographic, stacked. The trade line is lime + bold;
           *  "PROVE IT." is white italic, biggest weight in the stack.
           *  Sizes ramp up on md+ for the dare's full visual impact. */}
          <h1 className="font-display font-black leading-[0.95] tracking-tight mb-6 text-zinc-50">
            <span className="block text-3xl md:text-5xl font-bold text-zinc-200">
              Think you&rsquo;re the
            </span>
            {tradeDisplay && (
              <span
                className="block text-5xl md:text-7xl lg:text-8xl my-2 md:my-3"
                style={{
                  color: 'var(--color-lime)',
                  textShadow: '0 0 40px #c5ff3a44',
                }}
              >
                #1 {tradeDisplay}
              </span>
            )}
            {!tradeDisplay && (
              <span
                className="block text-5xl md:text-7xl lg:text-8xl my-2 md:my-3"
                style={{
                  color: 'var(--color-lime)',
                  textShadow: '0 0 40px #c5ff3a44',
                }}
              >
                #1
              </span>
            )}
            <span className="block text-3xl md:text-5xl font-bold text-zinc-200">
              in your city?
            </span>
            <span className="block text-5xl md:text-7xl lg:text-8xl italic mt-3 md:mt-5">
              PROVE IT.
            </span>
          </h1>

          {/* Subhead — frames how the dare is settled (with real data). */}
          <p className="text-base md:text-lg text-zinc-300 leading-relaxed mb-6 max-w-xl mx-auto md:mx-0">
            81 real Google searches across your service area. One
            quotable 0–100 score that tells you{' '}
            <strong className="font-bold text-zinc-100">exactly</strong>{' '}
            how visible you are — and which competitors are stealing
            your calls. Free. 60 seconds.
          </p>

          {/* Primary CTA — scrolls to the form section at the bottom. */}
          <a
            href="#prove-it-form"
            className="inline-flex items-center gap-2 px-7 py-3.5 rounded-md font-display font-bold text-base md:text-lg transition-all"
            style={{
              background: 'var(--color-lime)',
              color: '#000',
              boxShadow: '0 0 32px #c5ff3a55',
            }}
          >
            Run my proof — free
            <ArrowDown size={16} className="rotate-180" strokeWidth={2.75} />
          </a>

          {/* Hero-CTA sentinel — IntersectionObserver target for
           *  StickyFreeScoreBar. Zero-height div flush against the
           *  CTA so the sticky appears the moment the button itself
           *  leaves the viewport. */}
          <div id="prove-it-sticky-sentinel" aria-hidden="true" />

          <p className="text-xs text-zinc-500 mt-5 leading-relaxed">
            60-second delivery
            <span className="text-zinc-700 mx-2">·</span>
            No credit card
            <span className="text-zinc-700 mx-2">·</span>
            Real Google data, not estimates
          </p>

          {/* Optional walkthrough — same component /scan and
           *  /free-score use. Click-to-play. */}
          <LoomWalkthrough />
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 02 — TurfScore intro + value drive                              */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {/*
       *  Same intro as /free-score, lightly reframed for the
       *  ego-axis. Buyers who clicked the PROVE IT ad believe
       *  they're already #1; this section reframes the TurfScore
       *  as the receipt. */}
      <section
        className="px-5 md:px-8 py-10 md:py-16 border-t"
        style={{
          borderColor: 'var(--color-border)',
          background:
            'linear-gradient(180deg, transparent 0%, var(--color-card) 100%)',
        }}
      >
        <div className="max-w-2xl mx-auto">
          <div
            className="text-[10px] uppercase tracking-[0.22em] font-mono font-semibold mb-4"
            style={{ color: 'var(--color-lime)' }}
          >
            The TurfScore · the receipt
          </div>
          <h2 className="font-display text-2xl md:text-4xl font-black leading-[1.05] tracking-tight mb-5 text-zinc-50">
            One score, 0–100, that settles whether you&rsquo;re
            actually #1.
          </h2>
          <p className="text-base md:text-lg text-zinc-300 leading-relaxed mb-7 max-w-xl">
            Anyone can say they&rsquo;re &ldquo;the best&rdquo; in
            town. The TurfScore measures it — 81 real Google searches
            across your whole service area, rolled into one number
            you can quote, track, and improve. If you really are #1,
            you&rsquo;ll see it. If you&rsquo;re not, you&rsquo;ll see
            exactly where you&rsquo;re losing — and to whom.
          </p>

          {/* Three value pillars — same Quotable/Trackable/Actionable
           *  triad as /free-score's intro, here in the same 3-up
           *  card layout. */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-7">
            <ValuePillar
              icon={Target}
              label="Quotable"
              body="One 0–100 number. Settles the #1 argument in a board meeting, on a sales call, or with a partner."
            />
            <ValuePillar
              icon={TrendingUp}
              label="Trackable"
              body="Re-scan in 30 days. See the score climb (or not) as you fix what's actually broken."
            />
            <ValuePillar
              icon={Sparkles}
              label="Actionable"
              body="The score tells you where you stand. The AI Coach Fix List tells you what to do about it."
            />
          </div>

          {/* Band spectrum — where their score will land. */}
          <div
            className="rounded-lg border p-5"
            style={{
              background: 'var(--color-card)',
              borderColor: 'var(--color-border-bright)',
            }}
          >
            <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3">
              Where your score will land
            </div>
            <div className="grid grid-cols-5 gap-1.5 mb-3">
              <ScoreBand range="0–20" label="Invisible" color="#ff4d4d" />
              <ScoreBand range="20–40" label="Patchy" color="#ff9f3a" />
              <ScoreBand range="40–60" label="Solid" color="#e8e54a" />
              <ScoreBand range="60–80" label="Dominant" color="#c5ff3a" />
              <ScoreBand range="80+" label="Rare air" color="#f5c842" />
            </div>
            <p className="text-xs md:text-sm text-zinc-400 leading-relaxed mt-3">
              Most local businesses we scan land between{' '}
              <strong className="text-zinc-100">30 and 55</strong>{' '}
              before optimization. Above 60 is uncommon. Above 80 is
              rare air — the operators who actually own their city.
            </p>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 03 — Visual proof: THEM vs YOU split heatmap                    */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section
        className="px-5 md:px-8 py-10 md:py-14 border-t"
        style={{
          borderColor: 'var(--color-border)',
          background:
            'linear-gradient(180deg, transparent 0%, var(--color-card) 100%)',
        }}
      >
        <div className="max-w-3xl mx-auto">
          <h2 className="font-display text-2xl md:text-3xl font-black leading-tight tracking-tight mb-2 text-zinc-50 text-center md:text-left">
            What &ldquo;#1&rdquo; actually looks like — vs. what most
            operators have.
          </h2>
          <p className="text-sm md:text-base text-zinc-400 leading-relaxed mb-8 text-center md:text-left">
            Same city, same trade. The operator on the left owns the
            map pack. The one on the right thought they did too.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 md:gap-6">
            {/* THEM card */}
            <div
              className="rounded-lg border p-4 md:p-5"
              style={{
                background: 'var(--color-card)',
                borderColor: 'var(--color-border-bright)',
                boxShadow: '0 0 30px #c5ff3a14',
              }}
            >
              <div className="flex items-center justify-between mb-3">
                <div
                  className="text-[10px] uppercase tracking-[0.22em] font-mono font-bold"
                  style={{ color: 'var(--color-lime)' }}
                >
                  ACTUALLY #1
                </div>
                <div className="text-[10px] font-mono text-zinc-500">
                  TurfScore 82
                </div>
              </div>
              <HeatmapGrid cells={themCells} />
              <p className="text-xs text-zinc-400 mt-3 leading-relaxed">
                Visible in 74 of 81 neighborhoods. Owns the map pack.
              </p>
            </div>

            {/* YOU card */}
            <div
              className="rounded-lg border p-4 md:p-5"
              style={{
                background: 'var(--color-card)',
                borderColor: '#5a1f1f',
                boxShadow: '0 0 30px #ff4d4d14',
              }}
            >
              <div className="flex items-center justify-between mb-3">
                <div
                  className="text-[10px] uppercase tracking-[0.22em] font-mono font-bold"
                  style={{ color: '#ff4d4d' }}
                >
                  THOUGHT THEY WERE #1
                </div>
                <div className="text-[10px] font-mono text-zinc-500">
                  TurfScore 14
                </div>
              </div>
              <HeatmapGrid cells={youCells} />
              <p className="text-xs text-zinc-400 mt-3 leading-relaxed">
                Visible in 7 of 81. 91% of nearby searches go to a
                competitor.
              </p>
            </div>
          </div>

          {/* Scroll-to-form CTA */}
          <div className="mt-7 text-center">
            <a
              href="#prove-it-form"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-md font-semibold text-sm transition-all"
              style={{
                background: 'var(--color-lime)',
                color: '#000',
                boxShadow: '0 0 24px #c5ff3a40',
              }}
            >
              <ArrowDown size={14} className="rotate-180" strokeWidth={2.5} />
              Show me mine — free
            </a>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 04 — Testimonial                                                */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section
        className="px-5 md:px-8 py-10 md:py-14 border-t"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-2xl mx-auto">
          <div
            className="rounded-lg p-6 md:p-8 border relative"
            style={{
              background: 'var(--color-card)',
              borderColor: 'rgba(197, 255, 58, 0.35)',
              boxShadow: '0 0 30px #c5ff3a14',
            }}
          >
            <div
              className="font-display text-5xl md:text-6xl font-black leading-none absolute -top-1 left-5 md:left-7 select-none"
              style={{ color: 'var(--color-lime)' }}
              aria-hidden="true"
            >
              &ldquo;
            </div>
            <blockquote className="text-base md:text-lg text-zinc-50 leading-relaxed pt-4 md:pt-5">
              TurfMap caught a GBP category mismatch we&rsquo;d missed
              for 18 months. Fixed it the same day.
            </blockquote>
            <p className="mt-4 text-xs font-mono text-zinc-500 leading-relaxed">
              — Painting operator, Greater Toronto Area
            </p>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 05 — Top 3 truth                                                */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section
        className="px-5 md:px-8 py-10 md:py-16 border-t"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-2xl mx-auto">
          <div
            className="text-[10px] uppercase tracking-[0.22em] font-mono font-semibold mb-4"
            style={{ color: 'var(--color-lime)' }}
          >
            The Google Maps truth
          </div>
          <h2 className="font-display text-2xl md:text-4xl font-black leading-[1.05] tracking-tight mb-6 text-zinc-50">
            &ldquo;#1&rdquo; doesn&rsquo;t mean what you think it
            means.
          </h2>
          <div className="space-y-4 text-base text-zinc-300 leading-relaxed">
            <p>
              Google&rsquo;s local map pack shows three businesses —
              not one — when someone searches for your trade. Being
              &ldquo;#1&rdquo; in your city means being in the top 3
              consistently, not just at your own address.
            </p>
            <p>
              Google personalizes local results by where the searcher
              is standing. From your office, you&rsquo;ll always see
              yourself near the top — that&rsquo;s Google knowing your
              location, not proof you rank well. The customer 3 miles
              east is seeing somebody else.
            </p>
            <p>
              <strong className="font-semibold text-zinc-100">
                The free TurfScore checks 81 different points across
                your service area
              </strong>{' '}
              and shows you cell-by-cell where you make the top 3,
              where you don&rsquo;t, and which competitors take the
              call instead. That&rsquo;s the proof.
            </p>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 06 — What you get free vs paid unlock                           */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section
        className="px-5 md:px-8 py-10 md:py-16 border-t"
        style={{
          borderColor: 'var(--color-border)',
          background:
            'linear-gradient(180deg, var(--color-card) 0%, transparent 100%)',
        }}
      >
        <div className="max-w-2xl mx-auto">
          <div
            className="text-[10px] uppercase tracking-[0.22em] font-mono font-semibold mb-4"
            style={{ color: 'var(--color-lime)' }}
          >
            What you get
          </div>
          <h2 className="font-display text-2xl md:text-4xl font-black leading-tight tracking-tight mb-8 text-zinc-50">
            Free, in 60 seconds. The full receipts for $49.
          </h2>

          {/* Free pillar */}
          <div
            className="rounded-lg border p-5 md:p-6 mb-4"
            style={{
              background: 'var(--color-card-glow)',
              borderColor: 'var(--color-border-bright)',
            }}
          >
            <div className="flex items-center gap-2 mb-4">
              <Sparkles
                size={16}
                style={{ color: 'var(--color-lime)' }}
                strokeWidth={2.5}
              />
              <div
                className="text-[10px] uppercase tracking-[0.22em] font-mono font-bold"
                style={{ color: 'var(--color-lime)' }}
              >
                Free — no card
              </div>
            </div>
            <ul className="space-y-3 text-sm md:text-base text-zinc-200 leading-relaxed">
              <li className="flex items-start gap-3">
                <Check
                  size={16}
                  className="flex-shrink-0 mt-0.5"
                  style={{ color: 'var(--color-lime)' }}
                  strokeWidth={2.5}
                />
                <span>
                  <strong className="font-semibold text-zinc-50">
                    Your TurfScore
                  </strong>{' '}
                  — the single 0–100 number that tells you whether
                  you&rsquo;re actually #1 in your city.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <Check
                  size={16}
                  className="flex-shrink-0 mt-0.5"
                  style={{ color: 'var(--color-lime)' }}
                  strokeWidth={2.5}
                />
                <span>
                  <strong className="font-semibold text-zinc-50">
                    Map preview
                  </strong>{' '}
                  — the shape of your 81-cell territory.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <Check
                  size={16}
                  className="flex-shrink-0 mt-0.5"
                  style={{ color: 'var(--color-lime)' }}
                  strokeWidth={2.5}
                />
                <span>
                  <strong className="font-semibold text-zinc-50">
                    Your top 3 competitors — named
                  </strong>
                  . The businesses ranked above you, with how much
                  territory each one owns.
                </span>
              </li>
            </ul>
          </div>

          {/* $49 unlock pillar */}
          <div
            className="rounded-lg border p-5 md:p-6"
            style={{
              background: 'var(--color-card)',
              borderColor: 'var(--color-border)',
            }}
          >
            <div className="flex items-center gap-2 mb-4">
              <Lock size={16} className="text-zinc-400" strokeWidth={2.5} />
              <div className="text-[10px] uppercase tracking-[0.22em] font-mono font-bold text-zinc-400">
                Unlock the full report — $49
              </div>
            </div>
            <ul className="space-y-3 text-sm md:text-base text-zinc-300 leading-relaxed">
              <li className="flex items-start gap-3">
                <Target
                  size={16}
                  className="flex-shrink-0 mt-0.5 text-zinc-500"
                />
                <span>
                  <strong className="font-semibold text-zinc-100">
                    Cell-by-cell breakdown
                  </strong>{' '}
                  — every one of the 81 cells, with your exact rank
                  and the competitor in each slot.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <Sparkles
                  size={16}
                  className="flex-shrink-0 mt-0.5 text-zinc-500"
                />
                <span>
                  <strong className="font-semibold text-zinc-100">
                    AI Coach prioritized Fix List
                  </strong>{' '}
                  — three actions in priority order, written from
                  your real data.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <Crown
                  size={16}
                  className="flex-shrink-0 mt-0.5 text-zinc-500"
                />
                <span>
                  <strong className="font-semibold text-zinc-100">
                    30-day Pulse trial offered
                  </strong>{' '}
                  — optional weekly re-scans + Slack alerts to track
                  your TurfScore as the Fix List moves the needle.
                </span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 07 — Trust strip                                                */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section
        className="px-5 md:px-8 py-8 border-y"
        style={{
          borderColor: 'var(--color-border)',
          background: 'var(--color-card)',
        }}
      >
        <div className="max-w-3xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-8">
          <TrustItem icon={ShieldCheck} label="No card required">
            Free TurfScore. Your unlock decision happens AFTER you see
            your score, not before.
          </TrustItem>
          <TrustItem icon={Zap} label="Delivered in 60 seconds">
            81 real Google searches run in parallel. You see your
            score the moment the scan completes.
          </TrustItem>
          <TrustItem icon={Sparkles} label="Built by an agency">
            Proprietary technology of Fourdots Digital. We use TurfMap
            on every client engagement.
          </TrustItem>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 08 — Form section (the actual conversion event)                 */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {/*
       *  ScanIntakeForm in previewMode with leadSource='prove_it'.
       *  previewMode auto-renders the Cloudflare Turnstile widget
       *  when NEXT_PUBLIC_TURNSTILE_SITEKEY is set, and the
       *  preview-init endpoint verifies the token server-side —
       *  free-scan abuse protection without any extra wiring here.
       *  leadSource='prove_it' tags the cohort for the discounted
       *  unlock on /share (see lib/score/leadSources.ts). */}
      <section
        id="prove-it-form"
        className="px-5 md:px-8 py-12 md:py-20 border-t scroll-mt-20"
        style={{
          borderColor: 'var(--color-border-bright)',
          background:
            'linear-gradient(135deg, var(--color-card) 0%, var(--color-card-glow) 100%)',
        }}
      >
        <div className="max-w-2xl mx-auto">
          <div className="text-center md:text-left mb-7">
            <div
              className="text-[10px] uppercase tracking-[0.22em] font-mono font-semibold mb-3"
              style={{ color: 'var(--color-lime)' }}
            >
              Your turn · free TurfScore · 60 seconds
            </div>
            <h2 className="font-display text-3xl md:text-5xl font-black leading-tight tracking-tight mb-4 text-zinc-50">
              Settle it. Run the proof.
            </h2>
            <p className="text-base md:text-lg text-zinc-300 leading-relaxed max-w-xl mx-auto md:mx-0">
              <strong className="font-semibold text-zinc-50">
                If you really are #1:
              </strong>{' '}
              you&rsquo;ll have a quotable score to back it up.{' '}
              <strong className="font-semibold text-zinc-50">
                If you&rsquo;re not:
              </strong>{' '}
              you&rsquo;ll see exactly where you&rsquo;re losing —
              and to whom.
            </p>
          </div>

          <ScanIntakeForm
            previewMode
            leadSource="prove_it"
            useBusinessAutocomplete
            utmSource={utmSource}
            utmMedium={utmMedium}
            utmCampaign={utmCampaign}
            utmContent={utmContent}
            utmTerm={utmTerm}
            gclid={gclid}
            fbclid={fbclid}
          />

          <p className="mt-5 text-xs text-zinc-500 leading-relaxed text-center md:text-left">
            60-second delivery
            <span className="text-zinc-700 mx-2">·</span>
            No credit card
            <span className="text-zinc-700 mx-2">·</span>
            Real Google data, not estimates
          </p>
        </div>
      </section>

      {/* ─── Footer ──────────────────────────────────────────────────── */}
      <footer
        className="border-t px-5 md:px-8 py-6 text-xs text-zinc-600"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-3xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <span>
            TurfMap™ · Proprietary technology of{' '}
            <a
              href="https://fourdots.io"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Fourdots Digital
            </a>
          </span>
          <span className="flex items-center gap-4">
            <Link
              href="/#privacy"
              className="hover:text-zinc-400 transition-colors"
            >
              Privacy
            </Link>
            <Link
              href="/#terms"
              className="hover:text-zinc-400 transition-colors"
            >
              Terms
            </Link>
          </span>
        </div>
      </footer>

      {/* Bottom safe-area for the sticky bar — keeps the footer
       *  visible above the sticky when it re-appears past the form
       *  section. ~80px ≥ sticky height + iOS home indicator. */}
      <div className="h-20 md:hidden" />
    </div>
  );
}

function TrustItem({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof ShieldCheck;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Icon size={14} style={{ color: 'var(--color-lime)' }} />
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
          {label}
        </div>
      </div>
      <p className="text-sm text-zinc-400 leading-relaxed">{children}</p>
    </div>
  );
}

function ValuePillar({
  icon: Icon,
  label,
  body,
}: {
  icon: typeof Target;
  label: string;
  body: string;
}) {
  return (
    <div
      className="rounded-lg border p-4 md:p-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <Icon
          size={16}
          style={{ color: 'var(--color-lime)' }}
          strokeWidth={2.5}
        />
        <div className="text-[10px] uppercase tracking-[0.22em] font-mono font-bold text-zinc-200">
          {label}
        </div>
      </div>
      <p className="text-xs md:text-sm text-zinc-400 leading-relaxed">
        {body}
      </p>
    </div>
  );
}

function ScoreBand({
  range,
  label,
  color,
}: {
  range: string;
  label: string;
  color: string;
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <div
        className="w-full h-2 rounded-sm mb-1.5"
        style={{ background: color }}
        aria-hidden
      />
      <div className="text-[9px] md:text-[10px] uppercase tracking-wider font-mono font-bold text-zinc-200 leading-tight">
        {label}
      </div>
      <div className="text-[9px] font-mono text-zinc-500 leading-tight mt-0.5">
        {range}
      </div>
    </div>
  );
}
