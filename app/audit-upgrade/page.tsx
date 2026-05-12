/**
 * /audit-upgrade
 *
 * Landing page for the Stage 2 CRM-reactivation email "Add the
 * Roadmap" button. The cron stamps this URL into prospects.audit_upgrade_url:
 *   /audit-upgrade?source=stage_2_email&prospect_id=<id>
 *
 * The page is a thin redirect-style surface: when source=stage_2_email
 * and prospect_id is present, it POSTs to /api/upgrade/audit/create-session,
 * receives a Stripe Checkout URL, and redirects the buyer there. There's
 * no UI to confirm the charge — the email already pitched the upgrade,
 * the buyer clicked, and we trust their intent. They can still cancel
 * at the Stripe Checkout page.
 *
 * On error or ?cancelled=1, render a small recovery surface explaining
 * what happened and offering to retry.
 */

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ArrowLeft, AlertCircle, Check } from 'lucide-react';
import { MarketingFooter } from '@/components/marketing/MarketingFooter';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Visibility Audit upgrade — TurfMap™',
  description: 'Upgrade your scan to a full Visibility Audit.',
  robots: { index: false, follow: false },
};

export default async function AuditUpgradePage({
  searchParams,
}: {
  searchParams: Promise<{
    source?: string;
    prospect_id?: string;
    cancelled?: string;
  }>;
}) {
  const params = await searchParams;
  const source = params.source ?? '';
  const prospectId = params.prospect_id ?? '';
  const cancelled = params.cancelled === '1';

  // ─── Fast path: redirect straight to Stripe Checkout ──────────────
  // Only fires for clean Stage-2 entries (source matches + prospect_id
  // present + not the cancel-return path). The fetch hits our own API
  // — same origin — and the redirect target is Stripe's hosted page.
  //
  // We do this on the server so the buyer experiences a single redirect
  // hop from email click → Stripe Checkout. No interstitial flash.
  if (source === 'stage_2_email' && prospectId && !cancelled) {
    // Build an absolute URL to our own API route. In production this
    // resolves to https://www.turfmap.ai/api/...; in preview it resolves
    // to the preview deployment origin. Using a relative URL would fail
    // because server-side fetch needs an absolute URL.
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.turfmap.ai';
    try {
      const res = await fetch(
        `${origin}/api/upgrade/audit/create-session`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source: 'stage_2_email',
            prospect_id: prospectId,
          }),
          cache: 'no-store',
        }
      );
      const data = (await res.json()) as {
        checkout_url?: string;
        error?: string;
      };
      if (res.ok && data.checkout_url) {
        redirect(data.checkout_url);
      }
      // Falls through to the error-state render below with the API's
      // error message visible. Don't expose internal status codes.
      return renderErrorState({
        prospectId,
        message:
          data.error ??
          "We couldn't open the upgrade Checkout. Email anthony@fourdots.io and we'll fulfill manually.",
      });
    } catch (e) {
      // redirect() above throws a NEXT_REDIRECT signal that we MUST
      // rethrow — catching here would swallow the navigation. Same
      // for other thrown next/navigation signals.
      if (e instanceof Error && e.message.includes('NEXT_REDIRECT')) {
        throw e;
      }
      return renderErrorState({
        prospectId,
        message:
          'Network error contacting Stripe. Refresh to retry, or email anthony@fourdots.io.',
      });
    }
  }

  // ─── Cancel-return path ──────────────────────────────────────────
  if (cancelled) {
    return (
      <div className="min-h-screen flex flex-col">
        <header className="border-b" style={{ borderColor: 'var(--color-border)' }}>
          <div className="max-w-3xl mx-auto px-6 md:px-12 py-5 flex items-center justify-between">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <ArrowLeft size={14} /> Back to TurfMap
            </Link>
            <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
              Audit upgrade
            </div>
          </div>
        </header>
        <main className="flex-1 px-6 md:px-12 py-12 md:py-16">
          <div className="max-w-2xl mx-auto">
            <div
              className="border rounded-lg p-6 md:p-8"
              style={{
                background: 'var(--color-card)',
                borderColor: 'var(--color-border)',
              }}
            >
              <div className="flex items-start gap-3 mb-4">
                <Check
                  size={20}
                  strokeWidth={2.5}
                  className="flex-shrink-0 mt-0.5"
                  style={{ color: 'var(--color-lime)' }}
                />
                <div>
                  <h1 className="font-display text-xl md:text-2xl font-bold mb-2">
                    No problem — your scan is still yours.
                  </h1>
                  <p className="text-sm text-zinc-300 leading-relaxed">
                    The upgrade window stays open for 24 hours after your scan
                    completed. If you change your mind, click the link in the
                    email again or reply to anthony@fourdots.io and we&rsquo;ll
                    sort it out.
                  </p>
                </div>
              </div>
              {prospectId && source === 'stage_2_email' && (
                <Link
                  href={`/audit-upgrade?source=stage_2_email&prospect_id=${prospectId}`}
                  className="inline-flex items-center gap-2 rounded-md font-bold text-sm py-3 px-5 mt-4 transition-all hover:brightness-110"
                  style={{
                    background: 'var(--color-lime)',
                    color: 'black',
                  }}
                >
                  Try again →
                </Link>
              )}
            </div>
          </div>
        </main>
        <MarketingFooter />
      </div>
    );
  }

  // ─── Unknown source or missing prospect_id ───────────────────────
  return renderErrorState({
    prospectId: null,
    message:
      "This link is missing the buyer identifier. If you clicked from an email, the link may have been truncated — email anthony@fourdots.io with your business name and we'll sort it out.",
  });
}

function renderErrorState({
  prospectId,
  message,
}: {
  prospectId: string | null;
  message: string;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b" style={{ borderColor: 'var(--color-border)' }}>
        <div className="max-w-3xl mx-auto px-6 md:px-12 py-5 flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <ArrowLeft size={14} /> Back to TurfMap
          </Link>
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
            Audit upgrade
          </div>
        </div>
      </header>
      <main className="flex-1 px-6 md:px-12 py-12 md:py-16">
        <div className="max-w-2xl mx-auto">
          <div
            className="border rounded-lg p-6 md:p-8 flex items-start gap-3"
            style={{
              background: '#1a1308',
              borderColor: '#3a2a0a',
            }}
          >
            <AlertCircle
              size={20}
              strokeWidth={2.25}
              className="flex-shrink-0 mt-0.5"
              style={{ color: '#f5b651' }}
            />
            <div>
              <h1 className="font-display text-xl md:text-2xl font-bold mb-2">
                We couldn&rsquo;t open the upgrade.
              </h1>
              <p className="text-sm text-zinc-300 leading-relaxed">
                {message}
              </p>
              {prospectId && (
                <p className="text-xs text-zinc-500 mt-3 font-mono">
                  Reference: {prospectId}
                </p>
              )}
            </div>
          </div>
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
