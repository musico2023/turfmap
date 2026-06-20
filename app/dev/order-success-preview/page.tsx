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
  searchParams: Promise<{
    reopen?: string;
    extended?: string;
    /** Simulate the buyer having accepted the audit upgrade —
     *  passes isAuditUpgrade=true to OrderSuccessForm, which:
     *  (a) hides the AuditUpgradePanel (step 1)
     *  (b) shows the audit-purchased banner (with "Book your
     *      strategist call" button)
     *  (c) progresses to the Pulse step (or, if also ?skipPulse=1,
     *      straight to the success card with heatmap CTA).
     *  Use this to QA the post-audit-accept state without going
     *  through the real Stripe charge (which would fail against
     *  the mock session_id). */
    accepted?: string;
    /** When set alongside ?accepted=audit, simulates the buyer also
     *  skipping Pulse — drops the preview directly into step 3
     *  (banner + success card with heatmap CTA). */
    skipPulse?: string;
  }>;
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
  const auditAccepted = params.accepted === 'audit';

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
          <div className="text-zinc-400 leading-relaxed">
            Mock props are hydrated so this renders without a real
            Stripe session. Toggle states via URL params:
            <br />
            <span className="font-mono text-zinc-300">?</span> (no params)
            — Step 1: AuditUpgradePanel alone (default arrival state)
            <br />
            <span className="font-mono text-zinc-300">?accepted=audit</span> —
            Step 2: audit-purchased banner + PulseAttachPanel (post-1-click-accept)
            <br />
            <span className="font-mono text-zinc-300">?accepted=audit&amp;skipPulse=1</span> —
            Step 3: banner + success card with &ldquo;View my full TurfMap&rdquo;
            <br />
            <span className="font-mono text-zinc-300">?reopen=pulse&amp;extended=1</span> —
            recovery-email landing in 60-day extended trial mode
          </div>
        </div>

        <OrderSuccessForm
          tier="scan"
          sessionId="cs_preview_score_unlock_mock"
          keywordCount={1}
          prefillEmail="justinenns@gmail.com"
          // Null stripeCustomerId disqualifies the Pulse step (it
          // requires a customer to attach a subscription against),
          // which makes the sequenced flow short-circuit straight to
          // step 3 (success card). Use ?skipPulse=1 with ?accepted=audit
          // to see the final-step layout: banner + heatmap CTA, no
          // Pulse panel between them.
          stripeCustomerId={
            params.skipPulse === '1' ? null : 'cus_preview_mock'
          }
          attachState={null}
          attachPublicId={null}
          attachOnboardingStep={null}
          isAuditUpgrade={auditAccepted}
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
