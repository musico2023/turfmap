'use client';

/**
 * Inline Cal.com booking embed for the post-payment success state.
 *
 * Audit + Strategy buyers paid for a strategist call as part of the
 * deliverable. Embedding the calendar in-page keeps them on TurfMap
 * — no tab switch, no Cal.com chrome — so the entire premium flow
 * feels like one product.
 *
 * Pre-fills name + email + notes from props so the buyer doesn't
 * retype. The booking-success callback flips the parent state to a
 * "✓ Booked!" confirmation, mirroring what the buyer would have
 * seen on Cal.com directly.
 *
 * Falls back gracefully: if the Cal.com script is blocked (ad blocker,
 * strict CSP, etc.), an "Open Cal.com directly →" link still gets
 * the buyer to the same destination.
 *
 * Email-channel booking links are unchanged — emails can't embed JS,
 * so OrderConfirmationEmail still uses the standalone URL.
 */

import { useEffect, useMemo, useState } from 'react';
import Cal, { getCalApi } from '@calcom/embed-react';

export type CalEmbedProps = {
  /** Full Cal.com URL (e.g. https://cal.com/anthony-fourdots/audit-walkthrough?...).
   *  Same value the standalone link receives — we parse the slug
   *  out of it. */
  bookingUrl: string;
  /** Pre-fill the Cal.com booking form with the buyer's email. */
  email: string;
  /** Pre-fill the booking form's name field with the buyer's business. */
  businessName: string;
  /** Pre-fill the booking form's notes/additional-notes field. */
  notes?: string;
  /** Tier label for the heading copy. */
  tierLabel: string;
};

export function CalEmbed({
  bookingUrl,
  email,
  businessName,
  notes,
  tierLabel,
}: CalEmbedProps) {
  const [booked, setBooked] = useState(false);
  const [runtimeFailed, setRuntimeFailed] = useState(false);
  // calLink is the part Cal.com's embed expects — username/event-slug,
  // not a full URL. Memoized off the prop so the calculation only re-
  // runs if a new bookingUrl ever lands.
  const calLink = useMemo(() => parseCalLink(bookingUrl), [bookingUrl]);
  // Embed is unusable when the slug didn't parse OR the runtime init
  // threw. Both cases drop us to the link-only fallback.
  const embedFailed = !calLink || runtimeFailed;

  useEffect(() => {
    // No slug means the URL didn't parse — nothing to init; the
    // fallback render takes over.
    if (!calLink) return;
    let cancelled = false;
    (async () => {
      try {
        const cal = await getCalApi({ namespace: 'turfmap' });
        if (cancelled) return;
        // Dark theme + lime brand color so the embed visually
        // belongs to TurfMap. Cal.com applies these to the calendar
        // grid + buttons inside the iframe.
        cal('ui', {
          theme: 'dark',
          styles: { branding: { brandColor: '#c5ff3a' } },
          hideEventTypeDetails: false,
        });
        cal('on', {
          action: 'bookingSuccessful',
          callback: () => {
            if (!cancelled) setBooked(true);
          },
        });
      } catch (e) {
        console.warn('[CalEmbed] init failed', e);
        if (!cancelled) setRuntimeFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [calLink]);

  if (booked) {
    return (
      <div
        className="mt-8 mx-auto max-w-md rounded-lg border p-5 text-center"
        style={{
          borderColor: 'var(--color-lime, #c5ff3a)',
          background: 'rgba(197, 255, 58, 0.06)',
        }}
      >
        <p
          className="font-display text-base font-bold mb-1"
          style={{ color: 'var(--color-lime, #c5ff3a)' }}
        >
          ✓ Call booked
        </p>
        <p className="text-sm text-zinc-300 leading-relaxed">
          Check your inbox for the calendar invite. We&rsquo;ll send a
          reminder the day before — looking forward to walking you
          through your TurfMap.
        </p>
      </div>
    );
  }

  return (
    <div
      className="mt-8 mx-auto w-full max-w-3xl rounded-lg border overflow-hidden"
      style={{
        borderColor: 'var(--color-border)',
        background: 'var(--color-card)',
      }}
    >
      <div className="px-5 py-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
        <p className="font-display text-base font-bold text-zinc-100 mb-1">
          Book your {tierLabel}
        </p>
        <p className="text-xs text-zinc-500 leading-relaxed">
          Pick a time below. We&rsquo;ve pre-filled your details so the
          confirmation lands without you retyping.
        </p>
      </div>
      {!embedFailed && calLink && (
        <Cal
          namespace="turfmap"
          calLink={calLink}
          style={{ width: '100%', height: '700px', overflow: 'auto' }}
          config={{
            name: businessName,
            email,
            notes: notes ?? '',
            theme: 'dark',
          }}
        />
      )}
      {embedFailed && (
        <div className="px-5 py-6 text-center">
          <p className="text-sm text-zinc-300 mb-3">
            Calendar didn&rsquo;t load. Open Cal.com directly to book:
          </p>
          <a
            href={bookingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-md font-bold text-sm py-2.5 px-4 transition-all whitespace-nowrap hover:brightness-110"
            style={{ background: 'var(--color-lime)', color: 'black' }}
          >
            Book my call →
          </a>
        </div>
      )}
      <div className="px-5 py-3 border-t text-center" style={{ borderColor: 'var(--color-border)' }}>
        <a
          href={bookingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-zinc-500 hover:text-zinc-300"
        >
          Or open Cal.com in a new tab →
        </a>
      </div>
    </div>
  );
}

/**
 * Pull the Cal.com slug out of a full URL like
 * https://cal.com/anthony-fourdots/audit-walkthrough?email=...
 * Returns null when the URL doesn't match Cal.com (in which case the
 * embed gracefully falls back to the link).
 */
function parseCalLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'cal.com' && !parsed.hostname.endsWith('.cal.com')) {
      return null;
    }
    const slug = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    return slug || null;
  } catch {
    return null;
  }
}
