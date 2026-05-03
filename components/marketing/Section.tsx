import type { ReactNode } from 'react';

/**
 * Marketing-page section wrapper.
 *
 * Implements the eyebrow + H2 + body pattern shared across the landing
 * page (matches the cadence used on fourdots.io/home-services so the
 * two properties feel like the same brand family).
 *
 * Eyebrow includes a section number (01–07) that's auto-formatted —
 * pass `n={3}` and the eyebrow renders as "03 ·". Pass an explicit
 * `id` for anchor links from the top nav.
 *
 * The italicized phrase inside the H2 is rendered via children: pass
 * the heading content as plain JSX with `<em>…</em>` around the
 * phrase you want italic. (Fonts are wired so `em` inside Bricolage
 * Grotesque renders as Bricolage Italic — same family, just slanted.)
 */
export type SectionProps = {
  id?: string;
  /** 01–07 for the marketing landing. Padded to 2 digits. */
  n?: number;
  eyebrow: string;
  /** H2 content. Wrap an italic phrase in `<em>…</em>`. */
  heading: ReactNode;
  /** Lead paragraph rendered under the H2. */
  intro?: ReactNode;
  children: ReactNode;
  /** When true, applies a subtle alternating background tint to break
   *  the eye on a long page. */
  tint?: boolean;
};

export function Section({
  id,
  n,
  eyebrow,
  heading,
  intro,
  children,
  tint = false,
}: SectionProps) {
  const number = typeof n === 'number' ? String(n).padStart(2, '0') : null;
  return (
    <section
      id={id}
      className="border-b py-20 md:py-28 px-6 md:px-12"
      style={{
        borderColor: 'var(--color-border)',
        background: tint ? 'var(--color-card)' : 'transparent',
      }}
    >
      <div className="max-w-6xl mx-auto">
        <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-4">
          {number && (
            <span style={{ color: 'var(--color-lime)' }}>{number} · </span>
          )}
          {eyebrow}
        </div>
        <h2 className="font-display text-4xl md:text-5xl font-bold leading-[1.05] tracking-tight max-w-3xl mb-5">
          {heading}
        </h2>
        {intro && (
          <p className="text-zinc-400 text-base md:text-lg leading-relaxed max-w-2xl mb-10">
            {intro}
          </p>
        )}
        {children}
      </div>
    </section>
  );
}
