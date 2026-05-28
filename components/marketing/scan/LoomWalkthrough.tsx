'use client';

import { useState } from 'react';
import { Play } from 'lucide-react';
import { trackMetaEvent } from '@/components/marketing/scan/MetaPixel';

/**
 * Click-to-play Loom walkthrough card for the /scan hero.
 *
 * Renders the recording's animated thumbnail with a lime play-button
 * overlay. Tapping the card swaps the thumbnail for the live Loom
 * iframe (autoplay=1) inside the same aspect-preserving wrapper, so
 * the page doesn't reflow.
 *
 * Why a thumbnail + click-to-play (vs. eager iframe):
 *   - First-paint stays cheap. The Loom embed pulls ~600 KB of JS +
 *     a video chunk on mount; deferring keeps cold-Meta LCP clean.
 *   - The card is a stronger visual hook than a text link — the
 *     looping GIF previews the actual recording.
 *   - Buyers who don't want to watch can ignore it; the card is sized
 *     under the hero CTA so it doesn't compete for the buy decision.
 *
 * Thumbnail URL pattern: from Loom's oEmbed endpoint, the hash suffix
 * (`-1e62caa3a54dc550`) is version-pinned to the current recording.
 * If Loom regenerates thumbnails the hash will change; refresh via
 * `curl https://www.loom.com/v1/oembed?url=<share-url>&format=json`.
 *
 * Tracking: Meta custom WatchVideo event on first expand. Strong mid-
 * funnel engagement signal for Meta's audience optimization.
 */

const LOOM_VIDEO_ID = '47087d3d50ce4452813eb511c5503452';
const LOOM_EMBED_URL = `https://www.loom.com/embed/${LOOM_VIDEO_ID}`;
// Resolved via Loom's oEmbed endpoint — the hash suffix encodes the
// current recording. Plain <img> (not next/image) avoids needing a
// next.config.ts remotePatterns entry for the cdn.loom.com host, and
// animated GIFs don't benefit from next/image's static optimization.
const LOOM_THUMBNAIL_URL = `https://cdn.loom.com/sessions/thumbnails/${LOOM_VIDEO_ID}-1e62caa3a54dc550.gif`;
// padding-bottom % preserves Loom's embed-modal aspect ratio. Matches
// the value Loom's share dialog produces for this recording so the
// player renders without letterbox/crop seams on expand.
const VIDEO_ASPECT_PCT = 63.305978898007034;

export type LoomWalkthroughProps = {
  /** Optional eyebrow label rendered above the card. Default is an
   *  unobtrusive monospace tag noting this is OPTIONAL viewing so the
   *  hero's single-decision discipline stays intact. */
  eyebrow?: string;
  /** Class names appended to the outer wrapper. */
  className?: string;
};

export function LoomWalkthrough({
  eyebrow = 'Optional · 6-minute walkthrough',
  className = '',
}: LoomWalkthroughProps) {
  const [expanded, setExpanded] = useState(false);

  const onClick = () => {
    if (expanded) return;
    setExpanded(true);
    trackMetaEvent('WatchVideo', {
      content_name: 'TurfMap walkthrough',
      content_category: 'lander_demo',
    });
  };

  return (
    <div className={`mt-6 max-w-md mx-auto md:mx-0 ${className}`}>
      {eyebrow && (
        <div className="text-[10px] uppercase tracking-[0.22em] font-mono text-zinc-500 mb-2 text-center md:text-left">
          {eyebrow}
        </div>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={expanded}
        aria-label="Play the TurfMap walkthrough"
        className="block w-full rounded-lg overflow-hidden border relative group cursor-pointer disabled:cursor-default"
        style={{
          borderColor: 'var(--color-border-bright)',
          background: '#000',
        }}
      >
        <div
          className="relative w-full"
          style={{ paddingBottom: `${VIDEO_ASPECT_PCT}%` }}
        >
          {expanded ? (
            <iframe
              src={`${LOOM_EMBED_URL}?autoplay=1`}
              allow="autoplay; fullscreen; encrypted-media"
              allowFullScreen
              loading="lazy"
              className="absolute top-0 left-0 w-full h-full"
              title="TurfMap walkthrough"
            />
          ) : (
            <>
              {/* Plain <img> intentionally — animated GIF, no benefit
               *  from next/image static optimization, and avoids the
               *  next.config remotePatterns dance for cdn.loom.com. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={LOOM_THUMBNAIL_URL}
                alt="TurfMap walkthrough — preview"
                className="absolute top-0 left-0 w-full h-full object-cover"
                loading="lazy"
              />
              {/* Subtle dim layer so the play button has consistent
               *  contrast against the underlying preview frame. Hover
               *  lightens it slightly for click affordance. */}
              <div className="absolute inset-0 bg-black/35 group-hover:bg-black/20 transition-colors" />
              {/* Play button — lime to anchor the lander's accent
               *  palette into the demo card. Scales up slightly on
               *  hover to telegraph the click. */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div
                  className="w-16 h-16 md:w-20 md:h-20 rounded-full flex items-center justify-center transition-transform group-hover:scale-105"
                  style={{
                    background: 'var(--color-lime)',
                    boxShadow: '0 0 32px rgba(197, 255, 58, 0.55)',
                  }}
                >
                  {/* ml-1 nudges the triangle so its visual center
                   *  lands at the disc's geometric center (Play icon
                   *  is left-weighted). */}
                  <Play
                    size={26}
                    fill="black"
                    className="text-black ml-1"
                    strokeWidth={2.5}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </button>
    </div>
  );
}
