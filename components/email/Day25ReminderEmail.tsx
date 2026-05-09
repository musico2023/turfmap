/**
 * Day-25 buyer re-scan reminder — fires 25 days after the strategist
 * call completes (i.e., 5 days before the 30-day re-scan that gates
 * the TurfScore Lift Promise). Nudges the buyer to wrap any
 * outstanding Foundation-phase actions before the re-scan locks in
 * the lift number.
 */

import { EmailLayout, FactStrip, H1, P, PSmall, PrimaryButton } from './EmailLayout';

export type Day25ReminderEmailProps = {
  businessName: string;
  /** When the 30-day re-scan is scheduled to run. Pre-formatted by
   *  the cron, e.g. "Friday, June 13". */
  rescanDate: string;
  /** Buyer's TurfScore at audit time + the projected 30-day target.
   *  Both are surfaced inline so the buyer recalls the promise
   *  without scrolling back through their inbox. */
  startingTurfScore: number;
  projectedTurfScore: number;
  /** Dashboard URL — the buyer's per-action execution checklist
   *  lives here. Phase 4 will add the visual checklist; for Phase 3
   *  we just send them to /portal/<id>. */
  dashboardUrl: string;
  /** Public Roadmap PDF link — same URL the buyer received post-call
   *  via the Superhuman snippet. We re-attach it here so the email
   *  is self-contained even if the original got buried. */
  roadmapPdfUrl: string;
};

export function Day25ReminderEmail(props: Day25ReminderEmailProps) {
  const targetLift = props.projectedTurfScore - props.startingTurfScore;
  return (
    <EmailLayout
      preview={`Your 30-day re-scan runs ${props.rescanDate}`}
    >
      <H1>Your re-scan is in 5 days.</H1>

      <P>
        Quick check-in on <strong>{props.businessName}</strong>: your
        30-day re-scan runs <strong>{props.rescanDate}</strong>. That
        scan locks in your TurfScore Lift Promise number — the
        difference between today&rsquo;s score and where you started.
      </P>

      <FactStrip
        items={[
          { label: 'Started at', value: String(props.startingTurfScore) },
          { label: '30-day target', value: String(props.projectedTurfScore) },
          { label: 'Promise floor', value: '+10 pts' },
        ]}
      />

      <P>
        We projected a <strong>+{targetLift}-point</strong> lift if
        you complete the Foundation-phase actions (Weeks 1–4 of your
        Roadmap). The Lift Promise floor is +10 points — minimum 10,
        or we redo the analysis at no charge.
      </P>

      <P>
        <strong>If you&rsquo;re behind:</strong> the Roadmap is
        sequenced for a reason — the highest-impact actions are in
        Weeks 1–4. Knock those out this week if you can; the rescan
        will reflect them.
      </P>

      <PrimaryButton href={props.dashboardUrl}>
        Open my TurfMap →
      </PrimaryButton>

      <PSmall>
        Need to see the plan again?{' '}
        <a
          href={props.roadmapPdfUrl}
          style={{ color: '#a1a1aa', textDecoration: 'underline' }}
        >
          Re-open your 90-Day Roadmap
        </a>
        .
      </PSmall>
    </EmailLayout>
  );
}
