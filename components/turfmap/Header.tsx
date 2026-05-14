import Link from 'next/link';
import { Crosshair, LayoutGrid } from 'lucide-react';
import { SignOutButton } from './SignOutButton';
import { isAgencyOwnerEmail } from '@/lib/auth/agency';

export function Header({ userEmail }: { userEmail?: string | null } = {}) {
  // Show the explicit "Agency menu" button only for agency-owner
  // emails (fourdots.ca / fourdots.io). The button surfaces the
  // /clients route as an obvious affordance instead of relying on
  // the logo's invisible click target. Non-agency-owner emails get
  // the branded header without the menu — keeps the surface clean
  // for portal previews / future contractors.
  const showAgencyMenu = isAgencyOwnerEmail(userEmail ?? null);
  return (
    <header
      className="border-b px-8 py-5"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {/* Brand mark — links to /clients for agency-owner accounts;
           * stays a non-link mark for everyone else. The
           * /clients page itself enforces the same gate, so a
           * direct URL hit by a non-owner still gets blocked. */}
          {showAgencyMenu ? (
            <Link
              href="/clients"
              className="flex items-center gap-2.5 group"
              aria-label="TurfMap — agency home"
            >
              <BrandMark />
            </Link>
          ) : (
            <div className="flex items-center gap-2.5">
              <BrandMark />
            </div>
          )}
          {showAgencyMenu && (
            <Link
              href="/clients"
              className="ml-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-semibold transition-colors hover:bg-white/[0.03]"
              style={{
                borderColor: 'var(--color-border)',
                color: '#e4e4e7',
              }}
            >
              <LayoutGrid size={12} className="text-zinc-400" />
              Agency menu
            </Link>
          )}
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

/**
 * Inner brand-mark — the lime crosshair square + the TurfMap wordmark
 * + the "Geo-grid intelligence" subtitle. Extracted so the Header can
 * conditionally wrap it in a Link (for agency-owner emails) or
 * render as plain markup (for everyone else) without duplicating
 * the visual block.
 */
function BrandMark() {
  return (
    <>
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
    </>
  );
}
