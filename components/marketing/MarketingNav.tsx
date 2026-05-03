'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Crosshair } from 'lucide-react';
import { LinkButton } from '@/components/ui/Button';

/**
 * Top navigation for the marketing landing.
 *
 * Sticky to the top, gains a subtle border + backdrop blur after the
 * user scrolls past ~80px so the nav remains legible against
 * arbitrary section backgrounds without permanently competing with
 * the hero.
 *
 * Mobile collapses center links into a hamburger (deferred to a later
 * pass — desktop traffic is the primary audience for now).
 */
export function MarketingNav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 80);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 transition-all"
      style={{
        background: scrolled ? 'rgba(10,10,10,0.86)' : 'transparent',
        backdropFilter: scrolled ? 'blur(12px)' : 'none',
        WebkitBackdropFilter: scrolled ? 'blur(12px)' : 'none',
        borderBottom: scrolled
          ? '1px solid var(--color-border)'
          : '1px solid transparent',
      }}
    >
      <div className="max-w-6xl mx-auto px-6 md:px-12 h-16 flex items-center justify-between">
        <Link
          href="/"
          className="flex items-center gap-2 group"
          aria-label="TurfMap home"
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

        <div className="hidden md:flex items-center gap-7 text-sm">
          <a
            href="#section-02"
            className="text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            How it works
          </a>
          <a
            href="#section-05"
            className="text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            Pricing
          </a>
          <Link
            href="/login"
            className="text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            Sign in
          </Link>
        </div>

        <LinkButton variant="primary" size="md" href="#section-05">
          Order audit
        </LinkButton>
      </div>
    </nav>
  );
}
