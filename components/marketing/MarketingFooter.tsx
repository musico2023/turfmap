import { Crosshair } from 'lucide-react';

/**
 * Marketing-page footer.
 *
 * Three-column structure on desktop, stacked on mobile. Anchors the
 * page in three beats: identity (logo + tagline + parent attribution),
 * place + contact (so prospects can email a real person), and legal
 * (copyright + Privacy/Terms/Contact). Visual treatment stays subtle
 * and low-contrast — the footer is a gravity well, not a CTA.
 */
export function MarketingFooter() {
  const year = new Date().getFullYear();
  return (
    <footer
      className="border-t py-12 px-6 md:px-12 text-xs"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-12">
        {/* Left: identity */}
        <div className="space-y-3">
          <div className="flex items-center gap-2.5">
            <div
              className="w-7 h-7 rounded flex items-center justify-center"
              style={{ background: 'var(--color-lime)' }}
            >
              <Crosshair
                size={14}
                className="text-black"
                strokeWidth={2.75}
              />
            </div>
            <span className="font-display font-bold text-base text-zinc-200">
              TurfMap
              <span
                className="text-[10px] align-top ml-0.5"
                style={{ color: 'var(--color-lime)' }}
              >
                ™
              </span>
            </span>
          </div>
          <p className="text-zinc-500 leading-relaxed max-w-xs">
            Geo-grid local SEO diagnostic.
          </p>
          <p className="text-zinc-600 leading-relaxed max-w-xs">
            Proprietary technology of{' '}
            <a
              href="https://fourdots.io/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 hover:text-zinc-200 transition-colors underline-offset-2 hover:underline"
            >
              Fourdots Digital
            </a>
            .
          </p>
        </div>

        {/* Middle: place + contact */}
        <div className="space-y-3 md:pt-9">
          <p className="text-zinc-400 font-display font-semibold">
            Built in Toronto.
          </p>
          <p>
            <a
              href="mailto:hello@turfmap.ai"
              className="text-zinc-500 hover:text-zinc-200 transition-colors font-mono underline-offset-2 hover:underline"
            >
              hello@turfmap.ai
            </a>
          </p>
        </div>

        {/* Right: legal */}
        <div className="space-y-3 md:pt-9 md:text-right">
          <p className="text-zinc-600 font-mono">
            © {year} Fourdots Digital Inc.
          </p>
          <p className="font-mono text-zinc-600 flex items-center md:justify-end gap-3">
            <a
              href="https://fourdots.io/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-zinc-300 transition-colors"
            >
              Privacy
            </a>
            <span className="text-zinc-800">·</span>
            <a
              href="https://fourdots.io/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-zinc-300 transition-colors"
            >
              Terms
            </a>
            <span className="text-zinc-800">·</span>
            <a
              href="mailto:hello@turfmap.ai"
              className="hover:text-zinc-300 transition-colors"
            >
              Contact
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
