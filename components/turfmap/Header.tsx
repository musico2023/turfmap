import Link from 'next/link';
import { Crosshair } from 'lucide-react';
import { SignOutButton } from './SignOutButton';

export function Header({ userEmail }: { userEmail?: string | null } = {}) {
  return (
    <header
      className="border-b px-8 py-5"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {/* Brand mark links back to the agency home (/clients). Pre-
           * marketing-launch this was a static block; now `/` is the
           * public landing page so authed users need an explicit path
           * back to their console from any sub-route. */}
          <Link
            href="/clients"
            className="flex items-center gap-2.5 group"
            aria-label="TurfMap — agency home"
          >
            <div
              className="w-9 h-9 rounded-md flex items-center justify-center transition-shadow group-hover:shadow-[0_0_32px_#c5ff3a55]"
              style={{
                background: 'var(--color-lime)',
                boxShadow: '0 0 24px #c5ff3a40',
              }}
            >
              <Crosshair size={20} className="text-black" strokeWidth={2.75} />
            </div>
            <div>
              <div className="font-display text-2xl font-bold tracking-tight leading-none">
                TurfMap
                <span
                  className="text-xs align-top ml-0.5"
                  style={{ color: 'var(--color-lime)' }}
                >
                  ™
                </span>
              </div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mt-0.5">
                Geo-grid intelligence
              </div>
            </div>
          </Link>
        </div>
        <div className="flex items-center gap-5 text-xs">
          <div className="flex items-center gap-1.5 text-zinc-400">
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: 'var(--color-lime)',
                boxShadow: '0 0 8px #c5ff3a',
              }}
            />
            <span>System operational</span>
          </div>
          {userEmail && (
            <>
              <div
                className="h-4 w-px"
                style={{ background: 'var(--color-border)' }}
              />
              <span className="font-mono text-zinc-500 truncate max-w-[200px]">
                {userEmail}
              </span>
              <SignOutButton />
            </>
          )}
        </div>
      </div>
    </header>
  );
}
