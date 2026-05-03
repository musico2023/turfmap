/**
 * Agency-staff sign-in — `/login`. TurfMap-branded (lime accent + Crosshair
 * icon to match the dashboard Header). Mirrors the white-label portal login
 * structure, but always TurfMap-branded since this is the internal product.
 */

import { Crosshair } from 'lucide-react';
import { LoginForm } from './LoginForm';

export default async function AgencyLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;

  return (
    <div className="min-h-screen w-full text-white flex items-center justify-center px-6">
      <div
        className="w-full max-w-md rounded-lg border p-8"
        style={{
          background: 'var(--color-card)',
          borderColor: 'var(--color-border)',
        }}
      >
        <div className="flex items-center gap-3 mb-6">
          <div
            className="w-9 h-9 rounded-md flex items-center justify-center"
            style={{
              background: 'var(--color-lime)',
              boxShadow: '0 0 24px #c5ff3a40',
            }}
          >
            <Crosshair size={18} className="text-black" strokeWidth={2.5} />
          </div>
          <div>
            <div className="font-display text-lg font-bold leading-tight">
              TurfMap.ai
            </div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mt-0.5">
              Agency console · sign in
            </div>
          </div>
        </div>

        <LoginForm initialError={error ?? null} next={next ?? '/'} />

        <div
          className="mt-8 pt-5 border-t text-[10px] text-zinc-600 leading-relaxed flex items-start gap-3"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <a
            href="https://fourdots.io/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0 opacity-50 hover:opacity-80 transition-opacity"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/fourdots-logo.png"
              alt="Fourdots Digital"
              className="h-4 w-auto"
            />
          </a>
          <span>
            Proprietary technology of{' '}
            <span className="text-zinc-400 font-semibold">Fourdots Digital</span>.
            Access is restricted to agency staff.
          </span>
        </div>
      </div>
    </div>
  );
}
