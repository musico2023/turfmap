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
  Zap,
} from 'lucide-react';
import { ScanIntakeForm } from '@/components/marketing/scan/ScanIntakeForm';
import { HeatmapGrid, type HeatmapCell } from '@/components/turfmap/HeatmapGrid';
import { MetaPixelScrollDepth } from '@/components/marketing/scan/MetaPixel';

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
      {/* 01 — Hero (form inline, loss-framing matched to Meta creative)  */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section className="px-5 md:px-8 pt-8 pb-10 md:pt-14 md:pb-16">
        <div className="max-w-2xl mx-auto">
          {/* Eyebrow */}
          <div
            className="text-[11px] uppercase tracking-[0.22em] font-mono font-semibold mb-5"
            style={{ color: 'var(--color-lime)' }}
          >
            Free TurfScore · 60 seconds · No card required
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

          {/* Subhead */}
          <p className="text-base md:text-lg text-zinc-300 leading-relaxed mb-7 max-w-xl">
            Most local businesses are invisible in{' '}
            <strong className="font-bold text-zinc-100">two-thirds</strong>{' '}
            of their service area.{' '}
            <span className="block mt-3">
              See where you actually rank — block by block. Real Google
              data, 81 cells, your TurfScore in 60 seconds.
            </span>
          </p>

          {/* Inline form — anchor id lets the final-CTA scroll-up
           *  button target it. */}
          <div id="free-score-form" className="scroll-mt-20">
            <ScanIntakeForm
              previewMode
              utmSource={utmSource}
              utmMedium={utmMedium}
              utmCampaign={utmCampaign}
              utmContent={utmContent}
              utmTerm={utmTerm}
              gclid={gclid}
              fbclid={fbclid}
            />
          </div>

          {/* Trust microcopy below the form */}
          <p className="text-xs text-zinc-500 mt-5 leading-relaxed text-center md:text-left">
            60-second delivery
            <span className="text-zinc-700 mx-2">·</span>
            No credit card
            <span className="text-zinc-700 mx-2">·</span>
            Real Google data, not estimates
          </p>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
       * 02 — Visual proof: THEM vs YOU split heatmap
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
      {/* 03 — Top 3 truth (matches Meta creative #3)                     */}
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
                    Branded PDF report
                  </strong>{' '}
                  — keep it, share it, or hand it to a freelancer or
                  marketing vendor.
                </span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* 05 — Testimonial (reused from /scan)                            */}
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
      {/* 06 — Trust strip                                                */}
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
      {/* 07 — Final CTA (scroll back to top form)                        */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section
        className="px-5 md:px-8 py-12 md:py-20 border-t"
        style={{
          borderColor: 'var(--color-border-bright)',
          background:
            'linear-gradient(135deg, var(--color-card) 0%, var(--color-card-glow) 100%)',
        }}
      >
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="font-display text-3xl md:text-5xl font-black leading-tight tracking-tight mb-5 text-zinc-50">
            Find out what your map looks like.
          </h2>
          <p className="text-base md:text-lg text-zinc-300 leading-relaxed mb-7 max-w-xl mx-auto">
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
          <a
            href="#free-score-form"
            className="inline-flex items-center gap-2 px-7 py-3.5 rounded-md font-bold text-base md:text-lg transition-all"
            style={{
              background: 'var(--color-lime)',
              color: '#000',
              boxShadow: '0 0 32px #c5ff3a55',
            }}
          >
            Run my free TurfScore
            <ArrowDown size={16} className="rotate-180" strokeWidth={2.75} />
          </a>
          <p className="mt-4 text-xs font-mono text-zinc-500">
            60 seconds · no credit card · your real Google data
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
