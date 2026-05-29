'use client';

/**
 * ScanProgress — reassuring progress animation for the long scan
 * waits (40-120s+ typical) on TurfMap's primary flows.
 *
 * What it shows:
 *   - Rotating status phrases that reflect roughly what the backend
 *     is doing at each stage (mapping grid → querying SERPs →
 *     aggregating competitors → running NAP audit → generating AI
 *     Coach). Operators + buyers see motion and an evolving message,
 *     which kills the "is this frozen?" anxiety even though the
 *     phrases are time-based not event-driven.
 *   - A subtle lime pulse animation so the page doesn't feel static.
 *   - Elapsed-seconds counter at small size so the impatient know
 *     where we are.
 *
 * Why time-based rotation instead of streaming real progress events:
 *   The scan runs across multiple services (DFS, Supabase, Claude,
 *   DataForSEO for NAP) — wiring a true event stream from each into
 *   the page would require SSE / WebSocket plumbing across half the
 *   codebase. Time-based rotation is 30 lines of code and indistinguish-
 *   able from the buyer's perspective. Upgrade to event-streaming if/when
 *   we ever need to surface real failure points to the buyer (today
 *   we just retry server-side and don't expose retry signals).
 *
 * Phrase strategy:
 *   - A NARRATIVE phrase list runs once (~48s at the default 6s tick)
 *     telling the story of the scan: grid → SERPs → competitors →
 *     NAP → AI Coach → Fix List → finalizing. These should NOT loop —
 *     re-reading "Mapping 81 search points…" mid-scan would imply
 *     the work reset.
 *   - When the narrative exhausts and the scan still hasn't finished
 *     (now likely since /api/orders/fulfill auto-generates AI Coach
 *     for paid one-time tiers, pushing total wait past 100s), an
 *     OVERFLOW phrase list loops indefinitely. Overflow phrases are
 *     phrased to imply "still on the finalization step" so re-reading
 *     them doesn't break the perceived forward motion.
 */

import { useEffect, useState } from 'react';

export type ScanProgressProps = {
  /** Optional override of the narrative phrase list. Runs once.
   *  Default fits the standard geo-grid scan + NAP audit + AI Coach
   *  flow. */
  phrases?: string[];
  /** Optional override of the overflow phrase list. Loops indefinitely
   *  after the narrative phrases exhaust. Default phrasing implies
   *  "still finalizing" so re-reads don't break perceived motion. */
  overflowPhrases?: string[];
  /** Milliseconds each phrase holds before rotating. Default 6000ms. */
  rotateMs?: number;
  /** Optional className for the outer container. */
  className?: string;
  /** When true, hide the elapsed counter (e.g., on landing-page CTAs
   *  where the elapsed seconds would feel awkward). Default false. */
  hideElapsed?: boolean;
};

/** Narrative phrase list — calibrated for the full first-scan flow:
 *  DFS local-pack grid (30-90s) + DFS NAP audit (5-9s) + Claude AI
 *  Coach generation (10-30s). Each phrase ~6s = ~48s cycle. Runs ONCE
 *  — re-reading these mid-scan would imply we reset. */
const DEFAULT_PHRASES = [
  'Mapping 81 search points across your service area…',
  'Querying Google’s local 3-pack at each grid point…',
  'Aggregating competitor rankings cell-by-cell…',
  'Checking your business citations across 9 directories…',
  'Comparing your NAP against each directory’s listing…',
  'Generating your AI Coach playbook…',
  'Building your prioritized Fix List…',
  'Almost there — finalizing your TurfMap…',
];

/** Overflow phrase list — loops indefinitely after the narrative
 *  exhausts. Each phrase implies "still in the home stretch" rather
 *  than a discrete step, so cycling back to phrase 0 doesn't feel
 *  like a progress reset to the buyer. */
const DEFAULT_OVERFLOW_PHRASES = [
  'Cross-checking each Fix List recommendation…',
  'Polishing the AI Coach playbook…',
  'Reconciling competitor data across cells…',
  'Double-checking each finding before we hand it off…',
  'Putting the finishing touches on your TurfMap…',
];

export function ScanProgress({
  phrases = DEFAULT_PHRASES,
  overflowPhrases = DEFAULT_OVERFLOW_PHRASES,
  rotateMs = 6000,
  className = '',
  hideElapsed = false,
}: ScanProgressProps) {
  // Monotonic phrase index — keeps incrementing forever. We resolve
  // it against narrative + overflow lists in `currentPhrase` below so
  // overflow can loop without the index itself needing to reset.
  const [idx, setIdx] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);

  // Phrase rotation. Keep incrementing forever — `currentPhrase`
  // handles the narrative→overflow transition + the overflow loop.
  // The parent unmounts this component when the scan resolves, so
  // there's no "stop condition" inside the component itself.
  useEffect(() => {
    if (overflowPhrases.length === 0 && idx >= phrases.length - 1) {
      // No overflow configured + we've exhausted the narrative —
      // hold on the last narrative phrase (pre-overflow behavior).
      return;
    }
    const t = setTimeout(() => setIdx((i) => i + 1), rotateMs);
    return () => clearTimeout(t);
  }, [idx, phrases.length, overflowPhrases.length, rotateMs]);

  // Elapsed counter — 1Hz tick. Cheap; one setInterval. Used for
  // "30s" / "1m 12s" display, not for any logic.
  useEffect(() => {
    if (hideElapsed) return;
    const t = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [hideElapsed]);

  const elapsed = formatElapsed(elapsedSec);
  // Narrative first (idx < phrases.length), then overflow loops via
  // modulo on the tail. Defensive fallback to phrases[0] if both
  // lists are empty (which shouldn't happen with the default props
  // but keeps the component crash-proof for explicit overrides).
  const currentPhrase =
    idx < phrases.length
      ? phrases[idx]
      : overflowPhrases.length > 0
        ? overflowPhrases[(idx - phrases.length) % overflowPhrases.length]
        : (phrases[phrases.length - 1] ?? '');

  return (
    <div
      className={`relative flex flex-col items-center justify-center gap-4 py-12 ${className}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {/* Lime pulse — subtle visual confirmation that the page is
       *  alive. Uses CSS animation keyed off Tailwind's animate-pulse
       *  with a tighter timing courtesy of inline style. */}
      <div
        className="w-10 h-10 rounded-full"
        style={{
          background:
            'radial-gradient(circle at center, #c5ff3a 0%, rgba(197,255,58,0.18) 60%, transparent 100%)',
          animation: 'turfmap-pulse 1.6s ease-in-out infinite',
        }}
        aria-hidden="true"
      />
      <style jsx>{`
        @keyframes turfmap-pulse {
          0%, 100% { opacity: 0.55; transform: scale(0.95); }
          50%      { opacity: 1.0;  transform: scale(1.08); }
        }
      `}</style>

      {/* Current phrase. Fixed-height container so the surrounding
       *  layout doesn't reflow as phrases of different lengths swap
       *  in. 2 lines max — phrase list keeps everything ≤ ~70 chars. */}
      <div className="text-center text-zinc-200 text-base md:text-lg leading-snug max-w-md min-h-[3.25em] flex items-center justify-center px-4">
        <span
          key={idx}
          style={{ animation: 'turfmap-fade 600ms ease-out' }}
        >
          {currentPhrase}
        </span>
      </div>
      <style jsx>{`
        @keyframes turfmap-fade {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* Elapsed counter. Small, low-contrast — informational, not
       *  attention-grabbing. */}
      {!hideElapsed && (
        <div className="text-xs text-zinc-600 font-mono tracking-wide">
          {elapsed}
        </div>
      )}
    </div>
  );
}

/** "30s" / "1m 12s" / "2m 3s" formatting. Stays compact (≤6 chars
 *  in 99% of cases) so the small footer line doesn't shift width
 *  during the count. */
function formatElapsed(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}
