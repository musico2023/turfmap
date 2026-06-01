import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, Crosshair, Lock, Sparkles, Zap } from 'lucide-react';
import { ScanIntakeForm } from '@/components/marketing/scan/ScanIntakeForm';
import { TurfScoreShowcase } from '@/components/marketing/TurfScoreShowcase';

/**
 * /score — public TurfScore lead-magnet lander.
 *
 * Flow:
 *   1. Visitor fills the 5-field form (business, address, keyword,
 *      email, phone).
 *   2. Submit → POST /api/score/preview-init → runs the 81-point
 *      scan, creates a preview-mode share, redirects to /share/<id>.
 *   3. /share/<id> renders in PREVIEW MODE: TurfScore visible big,
 *      heatmap blurred, AI Coach hidden, $99 "Unlock the full map"
 *      CTA prominent.
 *   4. Visitor pays $99 → unlocks the same scan → lands on
 *      /order/success which auto-fulfills the rest (AI Coach gens,
 *      portal access provisions, audit-upgrade panel shows).
 *
 * Honest UX language:
 *   - "Free TurfScore" not "Free TurfScan" — what's free is the
 *     headline number, not the deliverable.
 *   - "Blurred map preview" is named explicitly below the form so
 *     visitors aren't surprised when they land on /share/<id>.
 *
 * noindex/nofollow — this lander shouldn't compete with /scan or
 * the homepage for organic queries. Outbound from this page is
 * email + paid traffic only.
 */

export const metadata: Metadata = {
  title: 'Get your free TurfScore · TurfMap',
  description:
    'See your local-search TurfScore for free. 81-point geo-grid scan, real-time. Unlock the full map for $99 — or just keep the score.',
  robots: { index: false, follow: false },
};

// Force dynamic rendering. The ScanIntakeForm client component
// pulls in Mapbox's AddressAutofill, whose JS bundle references
// `document` at module-evaluation time. Static prerender at build
// time evaluates these modules with no `document` defined and
// throws ReferenceError. /intake works because it uses await
// for the prospect lookup, which Next.js infers as dynamic; /score
// is otherwise fully static-eligible, so it needs the explicit flag.
export const dynamic = 'force-dynamic';

export default function ScoreLanderPage() {
  return (
    <div className="min-h-screen w-full text-white flex flex-col">
      {/* Slim nav — same shell as /intake so the visual rhythm is
       *  consistent for buyers who bounce between lander + intake. */}
      <nav
        className="border-b px-4 md:px-6 py-3 flex items-center justify-between"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="w-7 h-7 rounded flex items-center justify-center"
            style={{
              background: 'var(--color-lime)',
              boxShadow: '0 0 16px #c5ff3a30',
            }}
          >
            <Crosshair size={14} className="text-black" strokeWidth={2.75} />
          </div>
          <span className="font-display text-base font-bold">TurfMap.ai</span>
        </div>
        <Link
          href="/"
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors inline-flex items-center gap-1"
        >
          <ArrowLeft size={11} />
          Back to homepage
        </Link>
      </nav>

      <main className="flex-1 px-5 md:px-8 py-8 md:py-12">
        <div className="max-w-xl mx-auto">
          {/* Header */}
          <div
            className="text-[11px] uppercase tracking-[0.22em] font-mono font-semibold mb-3"
            style={{ color: 'var(--color-lime)' }}
          >
            Free TurfScore · 81 real Google searches
          </div>
          <h1 className="font-display text-3xl md:text-4xl font-black leading-tight tracking-tight mb-3 text-zinc-50">
            See your TurfScore in 60 seconds.
          </h1>
          <p className="text-base md:text-lg text-zinc-400 leading-relaxed mb-6">
            One number, 0–100, for how visible you are across your service
            area.
          </p>

          {/* Visual anchor — gives the buyer something concrete to look
           *  at while they read the form below. Score numerals stay at
           *  "??" placeholder (no fake demo data), but the band
           *  spectrum makes the 0-100 scale immediately graspable. */}
          <TurfScoreShowcase />

          {/* Form — reuses ScanIntakeForm in previewMode. previewMode
           *  forces 1 keyword regardless of tier, swaps the button copy
           *  + helper text to the free-score frame, and POSTs to
           *  /api/score/preview-init instead of the Stripe-checkout
           *  init route. */}
          <ScanIntakeForm previewMode />

          {/* What's included / what's locked — honest disclosure so
           *  the buyer isn't surprised when they land on the blurred
           *  share view. */}
          <div
            className="mt-8 pt-6 border-t"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] font-mono font-semibold text-zinc-500 mb-2 flex items-center gap-1.5">
                  <Sparkles
                    size={12}
                    style={{ color: 'var(--color-lime)' }}
                  />
                  Free
                </div>
                <ul className="space-y-1.5 text-zinc-300 leading-relaxed">
                  <li>· Your TurfScore (0–100) + band</li>
                  <li>· Headline diagnosis</li>
                  <li>· Invisible-cell count</li>
                  <li>· Heatmap preview (blurred)</li>
                </ul>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] font-mono font-semibold text-zinc-500 mb-2 flex items-center gap-1.5">
                  <Lock size={12} className="text-zinc-500" />
                  Unlock for $99
                </div>
                <ul className="space-y-1.5 text-zinc-400 leading-relaxed">
                  <li>· Full 81-cell heatmap, sharp</li>
                  <li>· Competitor breakdown by cell</li>
                  <li>· AI Coach Fix List (3 actions)</li>
                  <li>· 90-day Roadmap PDF</li>
                </ul>
              </div>
            </div>
          </div>

          {/* Trust strip — mirrors the /intake bottom bar. */}
          <div
            className="mt-6 pt-5 border-t"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <ul className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-zinc-400">
              <li className="flex items-start gap-2">
                <Zap
                  size={13}
                  className="flex-shrink-0 mt-0.5"
                  style={{ color: 'var(--color-lime)' }}
                />
                <span>Scan fires in under a minute</span>
              </li>
              <li className="flex items-start gap-2">
                <Sparkles
                  size={13}
                  className="flex-shrink-0 mt-0.5"
                  style={{ color: 'var(--color-lime)' }}
                />
                <span>Real Google data, not estimates</span>
              </li>
              <li className="flex items-start gap-2">
                <Lock
                  size={13}
                  className="flex-shrink-0 mt-0.5"
                  style={{ color: 'var(--color-lime)' }}
                />
                <span>We never share your details</span>
              </li>
            </ul>
          </div>
        </div>
      </main>
    </div>
  );
}
