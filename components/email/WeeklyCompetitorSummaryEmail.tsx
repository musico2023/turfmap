/**
 * Weekly competitor summary digest — Mondays.
 *
 * Compares the most recent scan to the same scan from 7 days prior
 * and surfaces three buckets: new competitors that entered the
 * 3-pack, ones that dropped out, and ones holding ground. Sent to
 * Pulse / Pulse+ buyers who have weekly_competitor_summary_email
 * enabled in their alert prefs.
 */

import {
  EmailLayout,
  H1,
  P,
  PSmall,
  PrimaryButton,
} from './EmailLayout';
import { Text } from '@react-email/components';

export type WeeklyCompetitorSummaryEmailProps = {
  businessName: string;
  /** Competitors that appeared in the 3-pack this week but not last
   *  week. Lime accent — implies threat. */
  entries: string[];
  /** Competitors that dropped out of the 3-pack since last week.
   *  Muted accent — informational. */
  exits: string[];
  /** Competitors holding the same position week-over-week. Default
   *  text color. */
  persistent: string[];
  /** Buyer-facing portal URL. */
  portalUrl: string;
};

export function WeeklyCompetitorSummaryEmail({
  businessName,
  entries,
  exits,
  persistent,
  portalUrl,
}: WeeklyCompetitorSummaryEmailProps) {
  return (
    <EmailLayout
      preview={`${businessName} — competitor activity, last 7 days`}
    >
      <H1>{businessName}{' '}— last 7 days.</H1>
      <P>
        Here&rsquo;s what&rsquo;s changed in your local 3-pack since
        last Monday.
      </P>

      <Section title="🆕 New entrants" color="#c5ff3a" names={entries} />
      <Section title="↘ Dropped out" color="#a1a1aa" names={exits} />
      <Section title="Holding ground" color="#e4e4e7" names={persistent} />

      <PrimaryButton href={portalUrl}>Open dashboard →</PrimaryButton>

      <PSmall>
        Your AI Coach playbook updates with each new scan — open the
        dashboard to see how this week&rsquo;s movement should change
        your priorities.
      </PSmall>
    </EmailLayout>
  );
}

function Section({
  title,
  color,
  names,
}: {
  title: string;
  color: string;
  names: string[];
}) {
  return (
    <Text
      style={{
        color: '#a1a1aa',
        fontSize: 14,
        margin: '8px 0',
        lineHeight: 1.6,
      }}
    >
      <strong style={{ color }}>{title}:</strong>{' '}
      {names.length === 0 ? 'none.' : `${names.join(', ')}.`}
    </Text>
  );
}
