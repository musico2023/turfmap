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
 * Cold-Meta paid-traffic landing page (/free-score).
 *
 * Sister page to /scan. /scan sells the $49 TurfScan up front to
 * cold Meta clicks. /free-score leads with the FREE TurfScore as the
 * entry point — buyer fills the form, the scan runs free, they land
 * on /share/<id> with a blurred map + their TurfScore + the top-3
 * named competitors visible. The $49 unlock CTA fires there.
 *
 * The argument for the free-first funnel on cold Meta traffic:
 *   - $49 cold-buy from Meta is brutal CAC math (expect <2% on most
 *     audiences). A free no-card entry typically lifts top-of-funnel
 *     conversion 8-15× on identical creative.
 *   - The /share preview page is already built (was originally for
 *     /score's lead-magnet flow), so we get the back-end mechanics
 *     for free.
 *   - We capture email + phone on the form, so an unconverted preview
 *     still feeds the drip sequence — recovery economics exist even
 *     when the buyer doesn't unlock today.
 *
 * This page is matched to four Meta ad creatives that share a
 * loss/invisibility/competitor-capture emotional axis:
 *   - "Every red square is a neighborhood sending jobs to your
 *     competitor"
 *   - "If you're not in the top 3 on Google Maps, you're INVISIBLE"
 *   - "This roofing company thought they ranked #1. 68% of their
 *     city couldn't find them."
 *   - (the ego-led "PROVE IT" creative gets its own lander —
 *     /proveit — built separately)
 *
 * Tone is louder and more visceral than /score's marketing-toned
 * free lander — Meta cold traffic responds to high-contrast loss
 * framing, not gentle product education.
 *
 * URL contract:
 *   /free-score                          — bare visit; defaults below
 *   /free-score?utm_source=meta&utm_*=…  — Meta-ad attribution;
 *                                          forwarded to the preview-
 *                                          init endpoint and stamped
 *                                          on the resulting client.
 *   /free-score?fbclid=…                 — auto-appended by Meta on
 *                                          ad clicks; carries through
 *                                          for Conversion API dedup.
 *
 * Meta pixel:
 *   - PageView fires automatically via MetaPixelBase in app/layout.
 *   - ViewContent fires at 50% scroll depth (engagement signal).
 *   - Lead fires when the preview-init succeeds (in ScanIntakeForm).
 */

export const metadata: Metadata = {
  title: 'Get your free TurfScore — TurfMap',
  description:
    "See exactly which Google Maps cells you're invisible in — and which competitors are taking the calls. Free TurfScore in 60 seconds. No card.",
  // Paid-traffic LP — same noindex treatment as /scan.
  robots: { index: false, follow: false },
};

// Force dynamic. Same reason as /score — the inline ScanIntakeForm
// pulls in Mapbox's AddressAutofill, which references `document` at
// module-eval time and crashes static prerender.
export const dynamic = 'force-dynamic';

const DEFAULT_UTM_SOURCE = 'meta_cold';
const DEFAULT_UTM_MEDIUM = 'paid_social';

function pickFirst(v: string | string[] | undefined): string | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

// ─── Stylized THEM vs YOU split heatmap data ─────────────────────────
//
// Two hand-tuned 9×9 patterns matching the Meta creative's split-screen
// visual. THEM = a competitor with strong territory dominance (mostly
// rank-1/2). YOU = the buyer's hypothetical pre-optimization position
// (mostly invisible + scattered rank-3s).
//
// The numbers aren't randomized — they're deterministic so the visual
// stays consistent across renders + screenshots. Both grids drive the
// existing HeatmapGrid component, so the lime/red color treatment
// matches the rest of the product.

const THEM_PATTERN = [
  '111122211', // y=0 — top edge, lime dominance
  '111122223', // y=1
  '111111223', // y=2
  '111111122', // y=3
  '111111112', // y=4 — center solid
  '111111122', // y=5
  '111111223', // y=6
  '111122223', // y=7
  '111122211', // y=8
] as const;

const YOU_PATTERN = [
  '.........', // y=0 — outer red
  '...3.....', // y=1
  '....3....', // y=2
  '...3.....', // y=3
  '....2.3..', // y=4 — sparse center
  '...3.....', // y=5
  '....3....', // y=6
  '...3.....', // y=7
  '.........', // y=8
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

export default async function ScanFreeLanderPage({
  searchParams,
}: {
  searchParams: Promise<{
    [key: string]: string | string[] | undefined;
  }>;
}) {
  const params = await searchParams;
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
       *  enters view. Sentinel ids are referenced below. */}
      <StickyFreeScoreBar
        heroSentinelId="free-score-sticky-sentinel"
        formAnchorId="free-score-form"
      />

      {/* ─── Top nav strip ───────────────────────────────────────────
       *  Brand mark only. No sign-in link — /free-score is a cold-Meta
       *  paid lander; existing customers don't arrive here, and an
       *  exit affordance pulls focus away from the single free-scan
       *  decision. */}
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
      {/* 01 — Hero (CTA + explainer Loom — form lives at the bottom)     */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {/*
       *  Restructured Dec 2026 to mirror /scan's lander cadence: hero
       *  explains the pitch + offers a Loom walkthrough; the form is
       *  pushed to its own section near the bottom of the page. The
       *  primary CTA is a scroll anchor down to that form section
       *  rather than a Stripe-checkout button, since /free-score is
       *  the free-TurfScore lead-magnet funnel (the $49 unlock fires
       *  later on /share).
       */}
      <section className="px-5 md:px-8 pt-8 pb-10 md:pt-14 md:pb-16">
        <div className="max-w-2xl mx-auto text-center md:text-left">
          {/* Eyebrow */}
          <div
            className="text-[11px] uppercase tracking-[0.22em] font-mono font-semibold mb-5"
            style={{ color: 'var(--color-lime)' }}
          >
            Free TurfScore · 60 seconds
          </div>

          {/* H1 — echoes Meta creative #1 (red square / neighborhood
           *  sending jobs). Color-painted spans match the creative's
           *  red-vs-lime emphasis: "neighborhoods" in red, "competitor"
           *  in lime — same vocabulary the ad just primed them on. */}
          <h1 className="font-display text-[34px] md:text-5xl font-black leading-[1.05] tracking-tight mb-5 text-zinc-50">
            Find the{' '}
            <span style={{ color: '#ff4d4d' }}>neighborhoods</span>{' '}
            sending your customers to your{' '}
            <span style={{ color: 'var(--color-lime)' }}>competitor</span>.
          </h1>

          {/* Subhead — frames the deliverable (TurfScore) up front so
           *  the buyer knows what they're getting. The detailed
           *  TurfScore explainer lives in its own section below. */}
          <p className="text-base md:text-lg text-zinc-300 leading-relaxed mb-6 max-w-xl mx-auto md:mx-0">
            Most local businesses are invisible in{' '}
            <strong className="font-bold text-zinc-100">two-thirds</strong>{' '}
            of their service area.{' '}
            <span className="block mt-3">
              Your free TurfScore (0–100) tells you exactly how visible
              you are across your whole service area — block by block,
              with named competitors taking your calls.
            </span>
          </p>

          {/* Primary CTA — scrolls down to the form section near the
           *  bottom. Lime fill matches the paid lander's primary
           *  button so the visual hierarchy is consistent across
           *  /scan and /free-score. */}
          <a
            href="#free-score-form"
            className="inline-flex items-center gap-2 px-7 py-3.5 rounded-md font-display font-bold text-base md:text-lg transition-all"
            style={{
              background: 'var(--color-lime)',
              color: '#000',
              boxShadow: '0 0 32px #c5ff3a55',
            }}
          >
            Get my free TurfScore
            <ArrowDown size={16} className="rotate-180" strokeWidth={2.75} />
          </a>

          {/* Hero-CTA sentinel — IntersectionObserver target the
           *  StickyFreeScoreBar uses to detect "the buyer scrolled
           *  past the hero CTA, time to surface the sticky." Zero-
           *  height div sits flush against the CTA so the sticky
           *  appears the moment the button itself leaves the
           *  viewport. */}
          <div id="free-score-sticky-sentinel" aria-hidden="true" />

          {/* Trust strip — three short items, comma + middle-dot
           *  separated. Mirrors the /scan hero's trust line. */}
          <p className="text-xs text-zinc-500 mt-5 leading-relaxed">
            60-second delivery
            <span className="text-zinc-700 mx-2">·</span>
            No credit card
            <span className="text-zinc-700 mx-2">·</span>
            Real Google data, not estimates
          </p>

          {/* Optional walkthrough — same component /scan uses. The
           *  thumbnail is click-to-play (Loom iframe mounts only on
           *  tap so first-paint stays cheap). Sized under the primary
           *  CTA's prominence so a buyer who's already decided
           *  doesn't feel pulled into a detour. */}
          <LoomWalkthrough />
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 02 — TurfScore intro + value drive                              */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {/*
       *  Explains what the deliverable IS before the buyer sees the
       *  visual proof. Most local-services operators have never had
       *  a single visibility metric — they have rank for 1 keyword
       *  from 1 location. The TurfScore is the answer to "what does
       *  my whole map look like, expressed as one number I can quote,
       *  track, and improve?"
       *
       *  Three value pillars (Quotable / Trackable / Actionable) map
       *  to the three operator jobs the metric does: report it to a
       *  partner / measure it over time / target the cells dragging
       *  it down. */}
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
            The TurfScore · one quotable number
          </div>
          <h2 className="font-display text-2xl md:text-4xl font-black leading-[1.05] tracking-tight mb-5 text-zinc-50">
            One score, 0–100, for how visible you are across your{' '}
            <em className="text-zinc-300">whole</em> service area.
          </h2>
          <p className="text-base md:text-lg text-zinc-300 leading-relaxed mb-7 max-w-xl">
            Local-services operators have always had rank for{' '}
            <strong className="font-semibold text-zinc-100">
              one keyword
            </strong>{' '}
            from{' '}
            <strong className="font-semibold text-zinc-100">
              one location
            </strong>
            . That number tells you almost nothing about where your
            real customers can find you. The TurfScore is different —
            it&rsquo;s a composite of 81 real Google searches across
            your service area, rolled into one quotable number you can
            actually track and improve.
          </p>

          {/* Three value pillars — same Quotable/Trackable/Actionable
           *  triad we use in /score's marketing copy, here in a
           *  three-up card layout so the value is scannable. */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-7">
            <ValuePillar
              icon={Target}
              label="Quotable"
              body="One 0–100 number. Drop it in a board deck, share it with a partner, hand it to a vendor."
            />
            <ValuePillar
              icon={TrendingUp}
              label="Trackable"
              body="Re-scan in 30 days. See the score climb as you optimize. Real proof your local SEO is working."
            />
            <ValuePillar
              icon={Sparkles}
              label="Actionable"
              body="The score tells you where you stand. The AI Coach Fix List tells you what to do about it."
            />
          </div>

          {/* Where your score will land — band spectrum. Lifted from
           *  /score's TurfScoreShowcase visual treatment so the
           *  vocabulary stays consistent across both lead-magnet
           *  landers, but rendered inline here as a compact 5-band
           *  strip rather than the full bullseye graphic. */}
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
              before optimization. Above 60 is uncommon — it usually
              means the Google Business Profile is well-tuned and the
              citations are clean.
            </p>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
       * 03 — Visual proof: THEM vs YOU split heatmap
       *
       * Direct visual match to Meta creative #1. Two 9×9 grids side
       * by side (stacked on mobile), labelled THEM (mostly lime —
       * the competitor's territory dominance) and YOU (mostly red —
       * the buyer's pre-optimization invisibility). Captioned with
       * the creative #4 case study line as the social-proof beat.
       * ═══════════════════════════════════════════════════════════════ */}
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
            This is what the same city looks like to{' '}
            <span style={{ color: 'var(--color-lime)' }}>them</span> — and to{' '}
            <span style={{ color: '#ff4d4d' }}>you</span>.
          </h2>
          <p className="text-sm md:text-base text-zinc-400 leading-relaxed mb-8 text-center md:text-left">
            Every red square is a neighborhood where you don&rsquo;t make
            Google&rsquo;s top 3 — and where your competitor does.
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
                  THEM
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
                  YOU
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

          {/* Social-proof case study line — matches Meta creative #4 */}
          <div
            className="mt-7 rounded-lg p-5 border-l-2"
            style={{
              background: 'var(--color-card)',
              borderLeftColor: 'var(--color-lime)',
            }}
          >
            <p className="text-sm md:text-base text-zinc-200 leading-relaxed">
              <strong className="font-semibold text-zinc-50">
                A real roofing company in suburban Oklahoma thought they
                ranked #1.
              </strong>{' '}
              When we scanned their territory,{' '}
              <span style={{ color: '#ff4d4d', fontWeight: 600 }}>
                68% of their city
              </span>{' '}
              couldn&rsquo;t find them in the top 3.
            </p>
          </div>

          {/* Scroll-up to form CTA */}
          <div className="mt-7 text-center">
            <a
              href="#free-score-form"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-md font-semibold text-sm transition-all"
              style={{
                background: 'var(--color-lime)',
                color: '#000',
                boxShadow: '0 0 24px #c5ff3a40',
              }}
            >
              <ArrowDown size={14} className="rotate-180" strokeWidth={2.5} />
              Run mine — free
            </a>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 04 — Testimonial (mirrors /scan's section 02.5 placement)       */}
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
      {/* 05 — Top 3 truth (matches Meta creative #3)                     */}
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
            If you&rsquo;re not in the top 3 on Google Maps, you&rsquo;re{' '}
            <span style={{ color: '#ff4d4d' }}>invisible</span>.
          </h2>
          <div className="space-y-4 text-base text-zinc-300 leading-relaxed">
            <p>
              Google&rsquo;s local map pack shows{' '}
              <strong className="font-semibold text-zinc-100">
                three businesses
              </strong>{' '}
              when someone searches for your trade in your city. Three.
              Not ten, not five — three.
            </p>
            <p>
              If you&rsquo;re #4 in a cell, you&rsquo;re effectively
              invisible to that searcher. Most operators don&rsquo;t know
              they&rsquo;re #4 in 40+ cells because Google personalizes
              local results by where the searcher is standing — and
              from your office, you&rsquo;ll always see yourself near
              the top.
            </p>
            <p>
              <strong className="font-semibold text-zinc-100">
                The free TurfScore checks 81 different points across your
                city
              </strong>{' '}
              and shows you cell-by-cell where you make the top 3, where
              you don&rsquo;t, and which competitors take the call
              instead.
            </p>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 04 — What you get free vs paid unlock                           */}
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
            Free, in 60 seconds. The full report is yours for $49.
          </h2>

          {/* Free pillar — what they get just by filling the form. */}
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
              <div className="text-[10px] uppercase tracking-[0.22em] font-mono font-bold"
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
                  — the single 0–100 number that tells you how visible
                  you are across your service area.
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
                  — the shape of your 81-cell territory. You see where
                  you&rsquo;re winning and losing at a glance.
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
                  . The businesses taking calls in your weak
                  neighborhoods, ranked by how much territory they own.
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
                  — every one of the 81 cells, with your exact rank and
                  the competitor in each slot.
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
                  — three actions in priority order, written from your
                  real data. Named directories, named competitors,
                  specific fixes.
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
            81 real Google searches run in parallel. You see your score
            and map preview the moment the scan completes.
          </TrustItem>
          <TrustItem icon={Sparkles} label="Built by an agency">
            Proprietary technology of Fourdots Digital. We use TurfMap
            on every client engagement.
          </TrustItem>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 07 — Form section (the actual conversion event)                 */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      {/*
       *  The form sits near the bottom of the page rather than in the
       *  hero. Hero-level CTAs above (and a final CTA further up the
       *  page) all anchor-scroll buyers to #free-score-form here.
       *
       *  Two-part framing inside this section:
       *    1. A small "Find out what your map looks like" headline +
       *       worst-case / best-case framer (lifted from the prior
       *       final-CTA section copy).
       *    2. The actual ScanIntakeForm in previewMode with
       *       leadSource='free_score' so the downstream /share unlock
       *       auto-applies MAPCHECK50.
       */}
      <section
        id="free-score-form"
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
              Find out what your map looks like.
            </h2>
            <p className="text-base md:text-lg text-zinc-300 leading-relaxed max-w-xl mx-auto md:mx-0">
              <strong className="font-semibold text-zinc-50">
                Worst case:
              </strong>{' '}
              you confirm what you suspect.{' '}
              <strong className="font-semibold text-zinc-50">
                Best case:
              </strong>{' '}
              you see exactly which neighborhoods to fix first — and
              which competitors to beat to do it.
            </p>
          </div>

          {/* The form. leadSource='free_score' tags the preview client
           *  for the MAPCHECK50 unlock discount on /share. */}
          <ScanIntakeForm
            previewMode
            leadSource="free_score"
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

/** Three-up "Quotable / Trackable / Actionable" value-driver card in
 *  the TurfScore intro section. Compact icon + label + body row. */
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

/** Single band tile in the "Where your score will land" 5-band strip.
 *  Color is the band's accent; range + label sit stacked beneath. */
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
