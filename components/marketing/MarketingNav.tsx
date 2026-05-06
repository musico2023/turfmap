'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Crosshair, Menu, X } from 'lucide-react';
import { LinkButton } from '@/components/ui/Button';

/**
 * Top navigation for the marketing landing.
 *
 * Sticky to the top, gains a subtle border + backdrop blur after the
 * user scrolls past ~80px so the nav remains legible against
 * arbitrary section backgrounds without permanently competing with
 * the hero.
 *
 * Mobile: center links + Sign in collapse into a hamburger panel.
 * The "Order audit" CTA stays visible at all viewport widths —
 * conversion CTAs should never hide behind a menu.
 */
export function MarketingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 80);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Close the mobile menu on resize past md breakpoint — avoids the
  // panel being stuck open if the buyer rotates a tablet to landscape.
  useEffect(() => {
    if (!menuOpen) return;
    const onResize = () => {
      if (window.innerWidth >= 768) setMenuOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [menuOpen]);

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 transition-all"
      style={{
        background: scrolled || menuOpen ? 'rgba(10,10,10,0.92)' : 'transparent',
        backdropFilter: scrolled || menuOpen ? 'blur(12px)' : 'none',
        WebkitBackdropFilter: scrolled || menuOpen ? 'blur(12px)' : 'none',
        borderBottom:
          scrolled || menuOpen
            ? '1px solid var(--color-border)'
            : '1px solid transparent',
      }}
    >
      <div className="max-w-6xl mx-auto px-6 md:px-12 h-16 flex items-center justify-between">
        <Link
          href="/"
          className="flex items-center gap-2 group"
          aria-label="TurfMap home"
          onClick={() => setMenuOpen(false)}
        >
          <div
            className="w-7 h-7 rounded flex items-center justify-center transition-shadow group-hover:shadow-[0_0_20px_#c5ff3a55]"
            style={{
              background: 'var(--color-lime)',
              boxShadow: '0 0 16px #c5ff3a30',
            }}
          >
            <Crosshair size={15} className="text-black" strokeWidth={2.75} />
          </div>
          <span className="font-display text-lg font-bold tracking-tight">
            TurfMap
            <span
              className="text-[10px] align-top ml-0.5"
              style={{ color: 'var(--color-lime)' }}
            >
              ™
            </span>
          </span>
        </Link>

        {/* Center links — desktop only. Mobile pulls these into the
         *  hamburger panel below. */}
        <div className="hidden md:flex items-center gap-7 text-sm">
          <a
            href="#section-02"
            className="text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            How it works
          </a>
          <a
            href="#section-04"
            className="text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            Pricing
          </a>
        </div>

        {/* Right cluster: Sign in sits adjacent to the primary CTA on
         *  desktop. On mobile, Sign in moves into the hamburger
         *  panel; the CTA stays visible since conversion-blocking it
         *  behind a menu is hostile. The hamburger toggle is
         *  positioned BEFORE the CTA in DOM order so screen readers
         *  hit it first when navigating from the right edge. */}
        <div className="flex items-center gap-3 md:gap-5">
          <Link
            href="/login"
            className="hidden md:inline-block text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            Sign in
          </Link>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="md:hidden inline-flex items-center justify-center w-9 h-9 rounded text-zinc-400 hover:text-zinc-100 transition-colors"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <LinkButton variant="primary" size="md" href="#section-04">
            Order audit
          </LinkButton>
        </div>
      </div>

      {/* Mobile menu panel — appears below the nav row when toggled.
       *  Hidden at md+ regardless of state. Tap-to-dismiss happens
       *  via clicking the close X or any link inside. */}
      {menuOpen && (
        <div
          className="md:hidden border-t"
          style={{
            background: 'rgba(10,10,10,0.95)',
            borderColor: 'var(--color-border)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
          }}
        >
          <div className="px-6 py-4 flex flex-col gap-1">
            <a
              href="#section-02"
              onClick={() => setMenuOpen(false)}
              className="py-3 text-base text-zinc-200 hover:text-zinc-100 transition-colors"
            >
              How it works
            </a>
            <a
              href="#section-04"
              onClick={() => setMenuOpen(false)}
              className="py-3 text-base text-zinc-200 hover:text-zinc-100 transition-colors"
            >
              Pricing
            </a>
            <Link
              href="/login"
              onClick={() => setMenuOpen(false)}
              className="py-3 text-base text-zinc-200 hover:text-zinc-100 transition-colors"
            >
              Sign in
            </Link>
          </div>
        </div>
      )}
    </nav>
  );
}
