import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, Check } from 'lucide-react';
import { OrderSuccessForm } from './OrderSuccessForm';
import { MarketingFooter } from '@/components/marketing/MarketingFooter';

export const metadata: Metadata = {
  title: 'Order received — TurfMap™',
  description: "We've got your order. One more step before we fire your scan.",
  robots: { index: false, follow: false },
};

/**
 * Post-Stripe-checkout landing page.
 *
 * Stripe redirects buyers here after successful payment, with
 * `tier=<scan|audit|strategy>&session_id=cs_xxx` in the query string.
 * The page server-renders a confirmation header + form for the buyer
 * to provide the business details we need to fire their scan
 * (business name, address, keyword(s), phone — email is fetched from
 * the Stripe session).
 *
 * The form submission and scan-trigger plumbing live in the client
 * component below. This page is rendered without auth — the
 * session_id is the proof-of-purchase that gates the form.
 */
export default async function OrderSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ tier?: string; session_id?: string }>;
}) {
  const { tier, session_id } = await searchParams;

  const tierLabel =
    tier === 'scan'
      ? 'TurfScan ($99)'
      : tier === 'audit'
        ? 'Visibility Audit ($499)'
        : tier === 'strategy'
          ? 'Strategy Session ($1,497)'
          : 'TurfMap';

  // Strategy tier scans 3 keywords; the others scan 1.
  const keywordCount = tier === 'strategy' ? 3 : 1;

  return (
    <div className="min-h-screen w-full text-white flex flex-col">
      <header
        className="border-b px-6 md:px-12 py-5"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <ArrowLeft size={14} />
            Back to TurfMap
          </Link>
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono">
            Order confirmation
          </div>
        </div>
      </header>

      <main className="flex-1 px-6 md:px-12 py-12 md:py-16">
        <div className="max-w-3xl mx-auto">
          <div
            className="border rounded-lg p-6 md:p-8 mb-8"
            style={{
              background: 'var(--color-card-glow)',
              borderColor: 'var(--color-border-bright)',
            }}
          >
            <div className="flex items-start gap-4">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                style={{
                  background: 'var(--color-lime)',
                  boxShadow: '0 0 24px #c5ff3a40',
                }}
              >
                <Check size={20} className="text-black" strokeWidth={3} />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-1">
                  Payment received
                </div>
                <h1 className="font-display text-2xl md:text-3xl font-bold mb-2">
                  Thanks — your {tierLabel} order is confirmed.
                </h1>
                <p className="text-zinc-300 leading-relaxed">
                  One more step. Tell us about your business and we&rsquo;ll
                  fire your scan immediately. You&rsquo;ll get an email with
                  your TurfMap link in under a minute.
                </p>
              </div>
            </div>
          </div>

          <Suspense
            fallback={
              <div className="text-sm text-zinc-500 font-mono">
                Loading order details…
              </div>
            }
          >
            <OrderSuccessForm
              tier={tier ?? null}
              sessionId={session_id ?? null}
              keywordCount={keywordCount}
            />
          </Suspense>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}
