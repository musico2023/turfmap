/**
 * /dev/order-success-preview — agency-only preview of the
 * /order/success page rendered in the score_unlock variant, with
 * mock prop hydration so it doesn't need a real Stripe session.
 *
 * Purpose: visual-only QA of the new "inline AuditUpgradePanel below
 * the success card" layout introduced for score_unlock buyers.
 * Standalone TurfScan buyers reach the AuditUpgradePanel through the
 * pre-intake gate; score_unlock buyers were previously bypassing
 * that gate entirely (done=true hydrates immediately to skip intake)
 * which incidentally skipped the upsell. This route mounts the same
 * OrderSuccessForm component the live page mounts, hydrated with
 * realistic score_unlock props, so you can see the new placement.
 *
 * Caveats:
 *   - Mock sessionId means clicking "Confirm $197 charge…" on the
 *     panel will fail (no real Stripe session to charge against).
 *     Purely visual.
 *   - Mock shareId means the "View my full TurfMap" CTA links to a
 *     /share/<id> that doesn't exist.
 *   - Same agency-owner email gate as /dev/email-preview and
 *     /dev/audit-fixture. Internal QA only.
 */

import { notFound } from 'next/navigation';
import { Header } from '@/components/turfmap/Header';
import { OrderSuccessForm } from '@/app/order/success/OrderSuccessForm';
import {
  isAgencyOwnerEmail,
  requireAgencyUserOrRedirect,
} from '@/lib/auth/agency';

export const dynamic = 'force-dynamic';

export default async function OrderSuccessPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ reopen?: string; extended?: string }>;
}) {
  const me = await requireAgencyUserOrRedirect('/dev/order-success-preview');
  if (!isAgencyOwnerEmail(me.email)) notFound();

  // Recovery-flow simulation. ?reopen=audit shows the audit step (the
  // default initial state anyway). ?reopen=pulse&extended=1 jumps the
  // sequence to the Pulse step in extended-trial mode (60-day offer).
  const params = await searchParams;
  const reopenTarget: 'audit' | 'pulse' | null =
    params.reopen === 'audit'
      ? 'audit'
      : params.reopen === 'pulse'
        ? 'pulse'
        : null;
  const extendedTrial =
    params.extended === '1' && reopenTarget === 'pulse';

  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={me.email} />

      <div className="px-8 py-6 max-w-3xl mx-auto">
        <div
          className="border rounded-md px-4 py-3 mb-6 text-xs leading-relaxed"
          style={{
            background: 'var(--color-card-glow)',
            borderColor: 'var(--color-border-bright)',
          }}
        >
          <div className="font-semibold text-zinc-100 mb-1">
            Preview: score_unlock /order/success layout
          </div>
          <div className="text-zinc-400">
            This is the new two-block layout — success card on top, audit
            upsell panel inlined below. Mock props are hydrated so this
            renders without a real Stripe session. Clicking the inline
            confirm or share CTAs will fail (mock data) — purely visual
            QA.
          </div>
        </div>

        <OrderSuccessForm
          tier="scan"
          sessionId="cs_preview_score_unlock_mock"
          keywordCount={1}
          prefillEmail="justinenns@gmail.com"
          stripeCustomerId="cus_preview_mock"
          attachState={null}
          attachPublicId={null}
          attachOnboardingStep={null}
          isAuditUpgrade={false}
          // Saved card means the 1-click inline confirm button renders
          // (vs the fallback "Add the Roadmap →" Stripe Checkout redirect).
          // Set to null instead to see the fallback variant.
          savedCard={{ brand: 'visa', last4: '4242' }}
          prospectId={null}
          cohort={null}
          amountTotalCents={4900}
          prefillKeyword={null}
          prefilledIntake={null}
          scoreUnlock={{
            shareId: '00000000-0000-0000-0000-000000000000',
            clientId: 'b44f0873-3086-465c-91c6-f4ef47d1dcec',
            scanId: '1423bdfd-62da-4285-af15-e37432688a38',
            clientPublicId: 'e06855db63',
            // Mock Cal.com booking URL — preview only. Real flow
            // resolves this server-side via calcomBookingUrlForTier
            // using the buyer's actual email + business_name.
            auditBookingUrl:
              'https://cal.com/turfmap/visibility-audit-walkthrough?email=preview%40example.com&name=Mock+Business',
          }}
          reopenTarget={reopenTarget}
          extendedTrial={extendedTrial}
        />
      </div>
    </div>
  );
}
