/**
 * Day-25 buyer re-scan reminder — fires 25 days after the strategist
 * call completes (i.e., 5 days before the 30-day Foundation-phase
 * re-scan). The 30-day re-scan is the EARLY progress checkpoint;
 * the TurfScore Lift Promise itself is measured at 90 days now (the
 * full Roadmap window). This email nudges the buyer to wrap
 * Foundation-phase actions so the 30-day checkpoint shows the
 * trajectory and the buyer can adjust before the 90-day measurement.
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
        30-day Foundation-phase re-scan runs{' '}
        <strong>{props.rescanDate}</strong>. This is the early
        progress checkpoint — the full TurfScore Lift Promise is
        measured at 90 days against the +10-point floor.
      </P>

      <FactStrip
        items={[
          { label: 'Started at', value: String(props.startingTurfScore) },
          { label: '30-day target', value: String(props.projectedTurfScore) },
          { label: '90-day floor', value: '+10 pts' },
        ]}
      />

      <P>
        We projected a <strong>+{targetLift}-point</strong>{' '}lift if
        you complete the Foundation-phase actions (Weeks 1–4 of your
        Roadmap). The 90-day Lift Promise floor is +10 points — if
        you implemented within 14 days and your TurfScore hasn&rsquo;t
        lifted 10 points by day 90, we refund your $499.
      </P>

      <P>
        <strong>If you&rsquo;re behind:</strong>{' '}the Roadmap is
        sequenced for a reason — the highest-impact actions are in
        Weeks 1–4. Knock those out this week if you can; the
        Foundation re-scan will reflect them and the 60-day check-in
        catches anything that needs course-correcting before the
        90-day measurement.
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
