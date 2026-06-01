/**
 * Preview-mode lock components for /share/<id> when the parent
 * client has is_preview=true (the /score lead-magnet flow).
 *
 * Three locks replace the three "money" surfaces a paid buyer would
 * see:
 *
 *   - PreviewHeatmapLock    wraps the live HeatmapWithToggle in a
 *                            CSS blur + lock overlay. Map is
 *                            visually present (the buyer sees the
 *                            shape of the heatmap and gets a sense
 *                            of where the hot/cold zones cluster)
 *                            but the cell-level detail is unreadable.
 *
 *   - PreviewAICoachLock     replaces the full AICoach panel with a
 *                            same-sized teaser. Same glow + lime
 *                            border vocabulary as the real one so
 *                            the unlock feels like turning the lights
 *                            on, not a different product appearing.
 *
 *   - PreviewCompetitorLock  replaces the CompetitorTable with a
 *                            single-line tease ("X competitors are
 *                            named in your full report") + ghost
 *                            unlock link.
 *
 * Reused across both first-time previewers AND visitors hitting an
 * already-unlocked share again (in that case is_preview=false and
 * none of these render).
 */

import { Lock, Sparkles, Crown } from 'lucide-react';
import {
  HeatmapWithToggle,
  type CompetitorView,
} from '@/components/turfmap/HeatmapWithToggle';
import type { HeatmapCell } from '@/components/turfmap/HeatmapGrid';
import { UnlockShareButton } from './UnlockShareButton';

// ─── Heatmap lock ──────────────────────────────────────────────────────

export type PreviewHeatmapLockProps = {
  shareId: string;
  clientCells: HeatmapCell[];
  clientName: string;
  competitors: CompetitorView[];
};

/**
 * Renders the real HeatmapWithToggle underneath, but with a CSS
 * blur + dark overlay + centered lock chip on top. The blur is
 * heavy enough that cell-level ranks are unreadable, but light
 * enough that the buyer perceives the shape (where the hot zones
 * cluster) — which makes the unlock feel like getting a known
 * good thing into focus, not a surprise.
 *
 * The HeatmapWithToggle is interactive (you can flip between the
 * client's view and a competitor's view) — we intentionally render
 * the toggle BENEATH the overlay (pointer-events:none on the
 * overlay container, but pointer-events:auto on the unlock chip
 * subtree). The blurred map still responds to hover etc. without
 * exposing readable detail.
 */
export function PreviewHeatmapLock({
  shareId,
  clientCells,
  clientName,
  competitors,
}: PreviewHeatmapLockProps) {
  return (
    <div className="relative">
      {/* Real heatmap, just blurred + desaturated. The wrapper's
       *  pointer-events:none keeps clicks from reaching the toggle
       *  underneath — they all fall through to the unlock CTA above. */}
      <div
        className="relative"
        style={{
          filter: 'blur(10px) saturate(0.65) brightness(0.8)',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
        aria-hidden
      >
        <HeatmapWithToggle
          clientCells={clientCells}
          clientName={clientName}
          competitors={competitors}
        />
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
            calls in your weak zones.
          </p>
        </div>
        <UnlockShareButton shareId={shareId} />
        <p className="text-[11px] text-zinc-500 font-mono">
          One-time $99. No subscription.
        </p>
      </div>
    </div>
  );
}

// ─── AI Coach lock ─────────────────────────────────────────────────────

export type PreviewAICoachLockProps = {
  shareId: string;
};

/**
 * Drop-in replacement for the AICoach panel in preview mode. Same
 * shell (lime border, gradient background, sparkle icon, heading)
 * so the unlock UX feels like flipping a switch on the same panel
 * rather than swapping a different thing in.
 */
export function PreviewAICoachLock({ shareId }: PreviewAICoachLockProps) {
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
            real data, ordered by impact. Unlock to see them.
          </p>
          <UnlockShareButton
            shareId={shareId}
            label="Unlock the Fix List — $99"
          />
        </div>
      </div>
    </div>
  );
}

// ─── Competitor table lock ─────────────────────────────────────────────

export type PreviewCompetitorLockProps = {
  shareId: string;
  /** Pre-aggregated top competitors from aggregateCompetitors().
   *  When non-empty, we reveal the top 3 names + their territory
   *  share so the buyer has something concrete + named to anchor
   *  on. The cell-by-cell breakdown (which cells each competitor
   *  owns) stays behind the unlock. */
  topCompetitors: Array<{
    name: string;
    /** Share of cells the competitor appeared in (0–100). */
    top3Pct: number;
    /** Average rank at the cells where they appeared (1.0–3.0).
     *  Null when the upstream aggregation didn't compute it (rare). */
    amr: number | null;
  }>;
  /** Total number of distinct competitor brands captured across the
   *  81 cells. Used in the "+ N more" upsell line below the top 3. */
  totalCompetitorCount: number;
};

/**
 * Sidebar-slot competitor surface for preview mode. Reveals the top
 * 3 dominators by territory share — names + share-of-cells. Keeps
 * the cell-by-cell breakdown (which cell each competitor sits at
 * which rank in) locked behind the $99 unlock.
 *
 * Rationale for the reveal: showing JUST a count ("12 competitors
 * are dominating you") was abstract and didn't anchor anything. Top
 * 3 names with their territory share make the score tangible — the
 * buyer can recognize Miami Chiropractic & Wellness, look it up, and
 * see why the unlock matters. The cell-level breakdown is the actual
 * deliverable the $99 unlocks.
 */
export function PreviewCompetitorLock({
  shareId,
  topCompetitors,
  totalCompetitorCount,
}: PreviewCompetitorLockProps) {
  const visible = topCompetitors.slice(0, 3);
  const moreCount = Math.max(0, totalCompetitorCount - visible.length);
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
          Top competitors in your territory
        </h4>
      </div>

      {visible.length > 0 ? (
        <ol className="space-y-2.5 mb-4">
          {visible.map((c, i) => (
            <li
              key={c.name}
              className="flex items-baseline gap-3 text-sm leading-tight"
            >
              <span
                className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 flex-shrink-0 w-5"
                aria-hidden
              >
                #{i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-zinc-100 truncate">
                  {c.name}
                </div>
                <div className="text-[11px] text-zinc-500 font-mono mt-0.5">
                  <span style={{ color: 'var(--color-lime)' }}>
                    {c.top3Pct}%
                  </span>{' '}
                  of cells
                  {typeof c.amr === 'number' && Number.isFinite(c.amr) ? (
                    <>
                      {' · '}avg rank {c.amr.toFixed(1)}
                    </>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          No dominant competitors surfaced for this keyword — your
          map looks clear, but the full unlock includes lower-traffic
          brands that may still be eating your visibility.
        </p>
      )}

      <div className="flex items-start gap-3 mb-3 pt-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
        <Lock size={14} className="text-zinc-500 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-zinc-400 leading-relaxed">
          {moreCount > 0 ? (
            <>
              <strong className="text-zinc-200">
                +{moreCount} more competitor{moreCount === 1 ? '' : 's'}
              </strong>{' '}
              named in the unlocked report — plus which cells each one
              owns and where you can flip the script.
            </>
          ) : (
            <>
              Unlock the full report to see exactly{' '}
              <strong className="text-zinc-200">which cells</strong>{' '}
              each competitor owns and where you can flip the script.
            </>
          )}
        </p>
      </div>
      <UnlockShareButton shareId={shareId} variant="ghost" />
    </div>
  );
}
