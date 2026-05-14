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
  /** Optional positioning sub-headline rendered between the H2 and
   *  the descriptive intro paragraph. Italic, smaller than H2, larger
   *  than body — same emphasis as the hero sub-headline. Acts as the
   *  one-line operator translation of what the section is about. */
  subHeading?: ReactNode;
  /** Lead paragraph rendered under the H2. */
  intro?: ReactNode;
  children: ReactNode;
  /** When true, applies a subtle alternating background tint to break
   *  the eye on a long page. */
  tint?: boolean;
  /** Optional visual that renders to the right of the eyebrow / H2 /
   *  intro on desktop. Stacks below the intro on mobile. Used by
   *  Section 03 for the "TurfMap AI Coach" signature card so the
   *  heading row isn't visually left-heavy. */
  headerAside?: ReactNode;
};

export function Section({
  id,
  n,
  eyebrow,
  heading,
  subHeading,
  intro,
  children,
  tint = false,
  headerAside,
}: SectionProps) {
  const number = typeof n === 'number' ? String(n).padStart(2, '0') : null;
  const headerBlock = (
    <>
      <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-4">
        {number && (
          <span style={{ color: 'var(--color-lime)' }}>{number} · </span>
        )}
        {eyebrow}
      </div>
      <h2
        className={`font-display text-4xl md:text-5xl font-bold leading-[1.05] tracking-tight max-w-3xl ${subHeading ? 'mb-3' : 'mb-5'}`}
      >
        {heading}
      </h2>
      {subHeading && (
        <p className="font-display text-xl md:text-2xl text-zinc-300 italic leading-snug max-w-2xl mb-6">
          {subHeading}
        </p>
      )}
      {intro && (
        <p className="text-zinc-400 text-base md:text-lg leading-relaxed max-w-2xl mb-10">
          {intro}
        </p>
      )}
    </>
  );
  return (
    <section
      id={id}
      className="border-b py-20 md:py-28 px-6 md:px-12 scroll-mt-24"
      style={{
        borderColor: 'var(--color-border)',
        background: tint ? 'var(--color-card)' : 'transparent',
      }}
    >
      <div className="max-w-6xl mx-auto">
        {headerAside ? (
          <div className="md:grid md:grid-cols-[1fr_auto] md:gap-10 md:items-start">
            <div>{headerBlock}</div>
            <div className="mt-8 md:mt-2 max-w-sm md:w-[300px] lg:w-[340px]">
              {headerAside}
            </div>
          </div>
        ) : (
          headerBlock
        )}
        {children}
      </div>
    </section>
  );
}
