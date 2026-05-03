import { Crosshair } from 'lucide-react';

/**
 * Marketing-page footer.
 *
 * Slim, attribution-forward — the landing is a single-page conversion
 * surface, not a content site, so links are minimal: legal, privacy,
 * Fourdots Digital backlink. No nav repetition (the top nav stays
 * sticky throughout the page).
 */
export function MarketingFooter() {
  const year = new Date().getFullYear();
  return (
    <footer
      className="border-t py-10 px-6 md:px-12 text-xs"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 text-zinc-500">
          <div
            className="w-6 h-6 rounded flex items-center justify-center"
            style={{ background: 'var(--color-lime)' }}
          >
            <Crosshair size={12} className="text-black" strokeWidth={2.75} />
          </div>
          <span className="font-display font-bold text-zinc-300">
            TurfMap
            <span
              className="text-[9px] align-top ml-0.5"
              style={{ color: 'var(--color-lime)' }}
            >
              ™
            </span>
          </span>
          <span className="text-zinc-700">·</span>
          <span>
            Proprietary technology of{' '}
            <a
              href="https://fourdots.io/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 hover:text-zinc-200 transition-colors underline-offset-2 hover:underline"
            >
              Fourdots Digital
            </a>
          </span>
        </div>
        <div className="flex items-center gap-5 text-zinc-600 font-mono">
          <span>© {year}</span>
          <a
            href="https://fourdots.io/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-zinc-300 transition-colors"
          >
            Privacy
          </a>
          <a
            href="https://fourdots.io/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-zinc-300 transition-colors"
          >
            Terms
          </a>
        </div>
      </div>
    </footer>
  );
}
