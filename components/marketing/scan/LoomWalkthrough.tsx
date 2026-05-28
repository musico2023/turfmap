'use client';

import { useState } from 'react';
import { Play } from 'lucide-react';
import { trackMetaEvent } from '@/components/marketing/scan/MetaPixel';

/**
 * Click-to-expand Loom walkthrough for the /scan hero.
 *
 * Collapsed by default — renders a small ghost button "Watch a quick
 * walkthrough" below the trust strip. Tapping expands an inline iframe
 * with autoplay. The collapsed state is intentionally low-pressure so
 * the hero's single-decision discipline (one CTA, one buy choice) isn't
 * diluted.
 *
 * Performance: the Loom iframe doesn't load until the buyer taps, so
 * cold-Meta first-paint metrics are unaffected. iframe is also marked
 * loading="lazy" as belt-and-braces.
 *
 * Tracking: fires a Meta custom WatchVideo event on expand. Strong
 * mid-funnel engagement signal for Meta ad optimization — the algorithm
 * can lean into audiences who actually watch the demo, not just see the
 * page.
 */

// Embed URL pulled from the share modal on Loom. The padding-bottom %
// preserves the recording's actual aspect ratio rather than a rounded
// 16:9; Loom-side switches re-render the canvas to a different ratio
// for some workflows so we match what the loom share modal provides.
const LOOM_EMBED_URL =
  'https://www.loom.com/embed/47087d3d50ce4452813eb511c5503452';
const VIDEO_ASPECT_PCT = 63.305978898007034;

export type LoomWalkthroughProps = {
  /** Override the trigger label. Default fits the /scan hero context. */
  label?: string;
  /** Class names appended to the wrapper. Lets the lander align the
   *  trigger to its surrounding column (centered hero CTA on mobile,
   *  left-aligned on desktop). */
  className?: string;
};

export function LoomWalkthrough({
  label = 'Watch a quick walkthrough',
  className = '',
}: LoomWalkthroughProps) {
  const [expanded, setExpanded] = useState(false);

  const onClick = () => {
    if (expanded) return;
    setExpanded(true);
    // Fire Meta custom event on first expand. WatchVideo isn't a
    // standard event but Meta logs custom names under the same pixel —
    // shows up in Events Manager under custom events.
    trackMetaEvent('WatchVideo', {
      content_name: 'TurfMap walkthrough',
      content_category: 'lander_demo',
    });
  };

  if (expanded) {
    return (
      <div className={`mt-6 ${className}`}>
        {/* aspect-preserving wrapper — padding-bottom maintains the
         *  Loom recording's native ratio while the iframe absolutely-
         *  fills the box. Bordered + rounded so it sits as a discrete
         *  card inside the hero rather than a raw video bleeding into
         *  the background. */}
        <div
          className="relative w-full rounded-lg overflow-hidden border"
          style={{
            paddingBottom: `${VIDEO_ASPECT_PCT}%`,
            borderColor: 'var(--color-border-bright)',
            background: '#000',
          }}
        >
          <iframe
            src={`${LOOM_EMBED_URL}?autoplay=1`}
            // Loom requires fullscreen permissions for the expand
            // button in their player chrome.
            allow="autoplay; fullscreen; encrypted-media"
            allowFullScreen
            loading="lazy"
            className="absolute top-0 left-0 w-full h-full"
            title="TurfMap walkthrough"
          />
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`mt-4 inline-flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors group ${className}`}
      aria-label="Play a one-minute walkthrough video"
    >
      <span
        className="w-6 h-6 rounded-full flex items-center justify-center transition-colors group-hover:bg-opacity-100"
        style={{
          background: 'rgba(197, 255, 58, 0.12)',
          border: '1px solid rgba(197, 255, 58, 0.35)',
        }}
      >
        <Play
          size={10}
          fill="currentColor"
          className="ml-px"
          style={{ color: 'var(--color-lime)' }}
        />
      </span>
      <span className="underline decoration-zinc-700 underline-offset-4 group-hover:decoration-zinc-500">
        {label}
      </span>
    </button>
  );
}
