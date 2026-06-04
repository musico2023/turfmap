/**
 * Preview-mode lock components for /share/<id> when the parent
 * client has is_preview=true (the /score lead-magnet flow).
 *
 * Three locks replace the three "money" surfaces a paid buyer would
 * see:
 *
 *   - PreviewHeatmapLock    renders a SERVER-GENERATED DECOY heatmap
 *                            under a lock overlay. The buyer's real
 *                            cell-by-cell rankings + competitor
 *                            per-cell data are NEVER shipped to the
 *                            browser for preview clients — the
 *                            payload is safe against DevTools "strip
 *                            the blur" inspection. See the decoy
 *                            generator + "Heatmap lock" header
 *                            comment for the full rationale.
 *
 *   - PreviewAICoachLock     replaces the full AICoach panel with a
 *                            same-sized teaser. Same glow + lime
 *                            border vocabulary as the real one so
 *                            the unlock feels like turning the lights
 *                            on, not a different product appearing.
 *
 *   - PreviewCompetitorLock  replaces the CompetitorTable with the
 *                            intentionally-revealed top-3 competitor
 *                            names (+ cell share + avg rank) and a
 *                            count of how many more sit behind the
 *                            unlock. Cell-by-cell rankings stay
 *                            server-side.
 *
 * Reused across both first-time previewers AND visitors hitting an
 * already-unlocked share again (in that case is_preview=false and
 * none of these render).
 */

import { Lock, Sparkles, Crown } from 'lucide-react';
import { HeatmapGrid, type HeatmapCell } from '@/components/turfmap/HeatmapGrid';
import { UnlockShareButton } from './UnlockShareButton';

// ─── Decoy heatmap (server-rendered, no real data) ────────────────────
//
// Previously the heatmap lock rendered the buyer's REAL cell-by-cell
// ranking data + every competitor's per-cell ranking and hid them
// with a CSS blur. That was bypassable in ~10 seconds with browser
// DevTools — strip the `filter: blur(...)` style and the entire
// unlocked product was readable in the DOM.
//
// Fix: don't ship the locked data to the browser at all. The buyer
// sees a band-keyed deterministic decoy heatmap. It looks like a
// real heatmap (uses the same HeatmapGrid component), but the
// 81-cell array driving it is pseudorandom data generated from the
// band label alone — no real rank, no competitor names, no
// per-cell payload. Even unblurred via DevTools, the buyer reads
// canned filler instead of their actual map.
//
// The distributions per band roughly match what a buyer in that
// band might expect to see (Invisible = mostly null, Patchy =
// sparse mid-ranks, Dominant = mostly rank-1) — convincing enough
// that the lock card doesn't read as "obviously fake," not so
// convincing that the buyer mistakes it for their own data.

type BandKey =
  | 'Invisible'
  | 'Patchy'
  | 'Solid'
  | 'Dominant'
  | 'Rare air'
  | 'Saturated';

const BAND_DISTRIBUTIONS: Record<
  BandKey,
  { rank1: number; rank2: number; rank3: number /* null = remainder */ }
> = {
  Invisible: { rank1: 0.0, rank2: 0.02, rank3: 0.05 },
  Patchy: { rank1: 0.08, rank2: 0.12, rank3: 0.18 },
  Solid: { rank1: 0.22, rank2: 0.18, rank3: 0.12 },
  Dominant: { rank1: 0.45, rank2: 0.2, rank3: 0.1 },
  'Rare air': { rank1: 0.7, rank2: 0.15, rank3: 0.05 },
  Saturated: { rank1: 0.7, rank2: 0.15, rank3: 0.05 },
};

/** Cheap, stable string hash — sufficient to seed the LCG below
 *  without pulling in crypto. We only need determinism, not
 *  cryptographic uniformity. */
function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Build a deterministic 81-cell decoy heatmap pattern from the band
 *  label. Same band always produces the same pattern — so the page
 *  doesn't visually shift on every render and the decoy stays
 *  consistent within a single browser session. */
function buildDecoyHeatmapCells(bandLabel: string | null): HeatmapCell[] {
  const key = (bandLabel ?? 'Patchy') as BandKey;
  const dist = BAND_DISTRIBUTIONS[key] ?? BAND_DISTRIBUTIONS.Patchy;
  // Linear congruential generator seeded by the band string —
  // deterministic + no crypto.random / Date.now (which break
  // server/client hydration parity in Next.js Server Components).
  let state = hashSeed(key);
  function nextRand(): number {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  }
  const cells: HeatmapCell[] = [];
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const r = nextRand();
      let rank: 1 | 2 | 3 | null;
      if (r < dist.rank1) rank = 1;
      else if (r < dist.rank1 + dist.rank2) rank = 2;
      else if (r < dist.rank1 + dist.rank2 + dist.rank3) rank = 3;
      else rank = null;
      cells.push({ x, y, rank });
    }
  }
  return cells;
}

// ─── Unlock price / cohort plumbing ────────────────────────────────────
//
// Cold-Meta /free-score buyers see the unlock at $49 (MAPCHECK50 auto-
// applied by unlock-init). Homepage /score buyers see $99. The
// `discountedUnlock` flag flows from the /share page server component
// (which reads lead_orders.stripe_metadata.lead_source) down to each
// lock so the copy stays in sync with the price Stripe will actually
// charge.
//
// Centralized here so we don't drift between the three lock components.

const PRICE_LIST_TEXT = '$99';
const PRICE_FREE_SCORE_TEXT = '$49';

type DiscountState = {
  /** Display price for "One-time $XX." footers + button labels. */
  priceText: string;
  /** Long-form "$99 → $49 with MAPCHECK50" framing when discounted;
   *  the bare "One-time $99. No subscription." footer when not. */
  footerText: string;
  /** Default UnlockShareButton label override.
   *
   *  Phrasing standardized across all three locks ("Unlock everything")
   *  so the buyer can't mis-read three "$49" buttons as three
   *  separate $49 purchases. ONE price gets the full bundle: heatmap +
   *  named competitors + AI Coach Fix List. Discounted-state version
   *  spells out the saving so the click feels like claiming a
   *  discount, not paying list. */
  buttonLabel: string;
  /** Inline "what's in the unlock" disclosure line, rendered next to
   *  every CTA so the bundle reality is obvious. Without this each
   *  lock card reads like its own paywall — buyers think "$49 for the
   *  map AND another $49 for the Fix List." Same string across all
   *  three locks for consistency. */
  bundleLine: string;
  /** Risk-reversal microcopy below each unlock button. Inherits the
   *  same money-back promise as the touch-2 drip email so the buyer
   *  sees the same guarantee on the page they're converting on. */
  refundLine: string;
};

function resolveDiscount(discountedUnlock: boolean): DiscountState {
  const sharedBundleLine =
    'One purchase unlocks all three: full 81-cell map · named competitors · AI Coach Fix List.';
  const sharedRefundLine =
    'Full refund within 7 days if the unlocked report doesn’t show you something you didn’t already know.';

  if (discountedUnlock) {
    return {
      priceText: PRICE_FREE_SCORE_TEXT,
      footerText:
        '$99 → $49 with MAPCHECK50 auto-applied. One-time, no subscription.',
      buttonLabel: 'Unlock everything — $49',
      bundleLine: sharedBundleLine,
      refundLine: sharedRefundLine,
    };
  }
  return {
    priceText: PRICE_LIST_TEXT,
    footerText: 'One-time $99. No subscription.',
    buttonLabel: 'Unlock everything — $99',
    bundleLine: sharedBundleLine,
    refundLine: sharedRefundLine,
  };
}

// ─── Heatmap lock ──────────────────────────────────────────────────────

export type PreviewHeatmapLockProps = {
  shareId: string;
  /** When true, render labels + footer with the discounted ($49)
   *  price. Driven upstream by lead_orders.stripe_metadata.lead_source
   *  === 'free_score'. */
  discountedUnlock?: boolean;
  /** Band label drives the decoy heatmap density (Patchy = sparse,
   *  Dominant = dense, etc.). Server passes
   *  `getTurfScoreBand(score).label`. */
  bandLabel?: string | null;
};

/**
 * Renders a SERVER-GENERATED DECOY heatmap underneath a lock
 * overlay. No real cell data, no competitor names, no per-cell
 * rankings ever ship to the browser for preview-cohort buyers —
 * the page payload is safe against DevTools "strip the blur"
 * inspection.
 *
 * Pre-fix this card rendered the real HeatmapWithToggle (with full
 * cell + competitor payload) and hid it with CSS. Anthony caught
 * the leak in prod — popping DevTools and removing the blur filter
 * revealed the entire unlocked product. The decoy approach trades
 * a small amount of "this is your real map shape" fidelity for
 * complete inspect-element resistance.
 *
 * The blur is still applied for visual continuity (the post-unlock
 * map appears in the same spot, sharp), but even an unblurred
 * decoy is just band-keyed pseudorandom data — useless to a
 * scraper, indistinguishable enough from a real map at a glance to
 * a buyer reading the lock chip.
 */
export function PreviewHeatmapLock({
  shareId,
  discountedUnlock = false,
  bandLabel,
}: PreviewHeatmapLockProps) {
  const discount = resolveDiscount(discountedUnlock);
  const decoyCells = buildDecoyHeatmapCells(bandLabel ?? null);
  return (
    <div className="relative">
      {/* Decoy heatmap — server-generated from the band label, no
       *  real cell data. Blurred + desaturated like the original
       *  for visual continuity; even un-blurred via DevTools it
       *  reveals only canned filler. pointer-events:none keeps
       *  clicks falling through to the unlock CTA above. */}
      <div
        className="relative"
        style={{
          filter: 'blur(10px) saturate(0.65) brightness(0.8)',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
        aria-hidden
      >
        <HeatmapGrid cells={decoyCells} />
      </div>

      {/* Lock overlay — dark gradient so the unlock chip pops, with
       *  a generous click target spanning the whole map area. */}
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-6"
        style={{
          background:
            'radial-gradient(circle at center, rgba(10,10,10,0.55) 0%, rgba(10,10,10,0.85) 70%)',
          borderRadius: '0.5rem',
        }}
      >
        <div
          className="flex items-center justify-center w-14 h-14 rounded-full"
          style={{
            background: 'var(--color-lime)',
            boxShadow: '0 0 40px #c5ff3a66',
          }}
        >
          <Lock size={22} className="text-black" strokeWidth={2.5} />
        </div>
        <div className="text-center max-w-sm">
          <div className="font-display text-xl md:text-2xl font-bold text-zinc-50 mb-1.5">
            Your full map is ready.
          </div>
          <p className="text-sm text-zinc-300 leading-relaxed">
            Unlock to see exactly which cells you&rsquo;re winning,
            losing, and missing — plus the named competitors taking
            calls in your weak zones <strong className="text-zinc-100">and</strong>{' '}
            your AI Coach Fix List.
          </p>
        </div>
        <UnlockShareButton shareId={shareId} label={discount.buttonLabel} />
        {/* Bundle-clarity line — same string across all three locks
         *  so a buyer scrolling can't mistake the three locked
         *  surfaces for three separate paywalls. */}
        <p className="text-[11px] text-zinc-200 leading-relaxed text-center max-w-sm">
          {discount.bundleLine}
        </p>
        <p className="text-[11px] text-zinc-500 font-mono text-center">
          {discount.footerText}
        </p>
        <p className="text-[11px] text-zinc-500 leading-relaxed text-center max-w-sm italic">
          {discount.refundLine}
        </p>
      </div>
    </div>
  );
}

// ─── AI Coach lock ─────────────────────────────────────────────────────

export type PreviewAICoachLockProps = {
  shareId: string;
  /** See PreviewHeatmapLockProps.discountedUnlock. */
  discountedUnlock?: boolean;
};

/**
 * Drop-in replacement for the AICoach panel in preview mode. Same
 * shell (lime border, gradient background, sparkle icon, heading)
 * so the unlock UX feels like flipping a switch on the same panel
 * rather than swapping a different thing in.
 */
export function PreviewAICoachLock({
  shareId,
  discountedUnlock = false,
}: PreviewAICoachLockProps) {
  const discount = resolveDiscount(discountedUnlock);
  return (
    <div
      id="ai-coach"
      className="rounded-lg p-6 relative overflow-hidden border scroll-mt-20"
      style={{
        background:
          'linear-gradient(135deg, var(--color-card) 0%, var(--color-card-glow) 100%)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div
        className="absolute top-0 right-0 w-96 h-96 rounded-full opacity-10 pointer-events-none"
        style={{
          background:
            'radial-gradient(circle, var(--color-lime), transparent 70%)',
          transform: 'translate(30%, -30%)',
        }}
      />

      <div className="flex items-start justify-between mb-5 relative">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <Sparkles size={16} style={{ color: 'var(--color-lime)' }} />
            <h3 className="font-display text-xl font-bold">
              TurfMap AI Coach
            </h3>
          </div>
          <p className="text-xs text-zinc-500">
            Your prioritized Fix List — written from your real audit
            data, not generic SEO advice
          </p>
        </div>
      </div>

      {/* Locked-state body */}
      <div className="relative space-y-4">
        <div
          className="rounded-md border p-5 text-center"
          style={{
            background: 'var(--color-bg)',
            borderColor: 'var(--color-border)',
          }}
        >
          <Lock
            size={18}
            className="mx-auto mb-3"
            style={{ color: 'var(--color-lime)' }}
          />
          <p className="text-sm text-zinc-300 leading-relaxed max-w-md mx-auto mb-4">
            Your <strong className="text-zinc-100">three prioritized
            actions</strong> are ready — specific fixes named to your
            real data, ordered by impact. They unlock together with
            your full map and named competitors.
          </p>
          <UnlockShareButton
            shareId={shareId}
            label={discount.buttonLabel}
          />
          {/* Same bundle disclosure + refund line as the heatmap
           *  lock so the buyer sees consistent terms on every CTA. */}
          <p className="text-[11px] text-zinc-200 leading-relaxed max-w-md mx-auto mt-4">
            {discount.bundleLine}
          </p>
          <p className="text-[11px] text-zinc-500 leading-relaxed max-w-md mx-auto mt-2 italic">
            {discount.refundLine}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Competitor table lock ─────────────────────────────────────────────

export type PreviewCompetitorLockProps = {
  shareId: string;
  /** Pre-aggregated top competitors from aggregateCompetitors().
   *  In PREVIEW MODE the `name` field is stripped server-side by the
   *  /share page (set to null in the payload that hydrates this
   *  component) — see the §4 load-bearing requirement of the re-gate
   *  ticket. Stats (top3Pct + amr) remain real and visible: they're
   *  the "proof the data is real," the names are the product. Once
   *  the buyer unlocks, this same component is no longer rendered —
   *  the unlocked path uses CompetitorTable with full names. */
  topCompetitors: Array<{
    /** Real cleaned business name in full mode; NULL in preview
     *  mode (server-side stripped). When null we render a masked
     *  "Competitor #N" label. */
    name: string | null;
    /** Share of cells the competitor appeared in (0–100). */
    top3Pct: number;
    /** Average rank at the cells where they appeared (1.0–3.0).
     *  Null when the upstream aggregation didn't compute it (rare). */
    amr: number | null;
  }>;
  /** Total number of distinct competitor brands captured across the
   *  81 cells. Used in the "+ N more" upsell line below the top 3. */
  totalCompetitorCount: number;
  /** See PreviewHeatmapLockProps.discountedUnlock. */
  discountedUnlock?: boolean;
  /** Server-computed share (0–100) of the buyer's 81 cells where
   *  the #1 competitor outranks them. Drives the hero alarm line.
   *  Null when the leader can't be matched against any cell (no
   *  data) or when leaderShare === 0 — caller renders fallback copy
   *  in either case. Never a placeholder; always derived from the
   *  buyer's real scan_points data. */
  leaderShare?: number | null;
};

/**
 * Sidebar-slot competitor surface for preview mode. Reveals real
 * cell_share + avg_rank STATS for the top 3 dominators but masks
 * their names — the dominance/proof is visible (so the buyer can see
 * the data is real); the identities unlock with the $49 purchase.
 *
 * Hero line: "The #1 operator in your market holds X% of the
 * neighborhoods where you're invisible — and they're not the only
 * one outranking you." Uses real leaderShare; falls back to non-%
 * copy when the value can't be computed.
 *
 * Originally this card REVEALED the top-3 names for free (the
 * "strongest single piece of free value"), but the re-gate ticket
 * concluded that handing over the names defuses exactly the
 * curiosity that drives the $49 unlock. Now: stats prove the data
 * is real, names are the payoff.
 */
export function PreviewCompetitorLock({
  shareId,
  topCompetitors,
  totalCompetitorCount,
  discountedUnlock = false,
  leaderShare = null,
}: PreviewCompetitorLockProps) {
  const visible = topCompetitors.slice(0, 3);
  const moreCount = Math.max(0, totalCompetitorCount - visible.length);
  const discount = resolveDiscount(discountedUnlock);
  // Hero alarm line gating per ticket §6 fallback rule:
  //   leaderShare null OR 0 → render fallback hero (no % line).
  //   leaderShare positive → render the templated alarm with the
  //     real %.
  const showLeaderShareHero =
    typeof leaderShare === 'number' &&
    Number.isFinite(leaderShare) &&
    leaderShare > 0;

  return (
    <div
      className="rounded-lg border p-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="flex items-center gap-2 mb-3">
        <Crown size={14} style={{ color: 'var(--color-lime)' }} />
        <h4 className="text-xs uppercase tracking-[0.18em] font-mono font-semibold text-zinc-300">
          Competitor intel
        </h4>
      </div>

      {/* Hero alarm line — the emotional anchor that the masked rows
       *  below pay off. Uses real leaderShare, falls back to a
       *  count-led line when the metric can't be computed. */}
      {visible.length > 0 && (
        <p className="text-sm text-zinc-200 leading-relaxed mb-4">
          {showLeaderShareHero ? (
            <>
              The #1 operator in your market holds{' '}
              <strong
                className="font-bold"
                style={{ color: 'var(--color-warn)' }}
              >
                {leaderShare}%
              </strong>{' '}
              of the neighborhoods where you&rsquo;re invisible — and
              they&rsquo;re not the only one outranking you.
            </>
          ) : (
            <>
              Three competitors are outranking you in the
              neighborhoods where you&rsquo;re invisible. Unlock to
              see who.
            </>
          )}
        </p>
      )}

      {visible.length > 0 ? (
        <ol className="space-y-2.5 mb-4">
          {visible.map((c, i) => {
            const isMasked = c.name === null;
            const displayName = isMasked
              ? `Competitor #${i + 1}`
              : c.name;
            return (
              <li
                key={i}
                className="flex items-baseline gap-3 text-sm leading-tight"
              >
                <span
                  className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 flex-shrink-0 w-5"
                  aria-hidden
                >
                  #{i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-zinc-100 truncate flex items-center gap-1.5">
                    {isMasked && (
                      <Lock
                        size={12}
                        className="text-zinc-500 flex-shrink-0"
                        aria-hidden
                      />
                    )}
                    <span className={isMasked ? 'text-zinc-300' : ''}>
                      {displayName}
                    </span>
                  </div>
                  <div className="text-[11px] text-zinc-500 font-mono mt-0.5">
                    <span style={{ color: 'var(--color-lime)' }}>
                      {c.top3Pct}%
                    </span>{' '}
                    cell share
                    {typeof c.amr === 'number' && Number.isFinite(c.amr) ? (
                      <>
                        {' · '}avg rank #{c.amr.toFixed(1)}
                      </>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          No dominant competitors surfaced for this keyword — your
          map looks clear, but the full unlock includes lower-traffic
          brands that may still be eating your visibility.
        </p>
      )}

      {moreCount > 0 && (
        <div
          className="flex items-start gap-3 mb-3 pt-3 border-t"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <Lock size={14} className="text-zinc-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-zinc-400 leading-relaxed">
            <strong className="text-zinc-200">
              +{moreCount} more competitor
              {moreCount === 1 ? '' : 's'}
            </strong>{' '}
            named in the unlocked report — plus which cells each one
            owns and where you can flip the script.
          </p>
        </div>
      )}

      <UnlockShareButton
        shareId={shareId}
        variant="ghost"
        label={discount.buttonLabel}
      />
      {/* Bundle disclosure — keeps the sidebar CTA framing
       *  consistent with the heatmap + AI Coach locks. */}
      <p className="text-[10px] text-zinc-500 leading-relaxed mt-2">
        {discount.bundleLine}
      </p>
    </div>
  );
}
