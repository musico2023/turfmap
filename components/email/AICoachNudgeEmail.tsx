/**
 * AICoachNudgeEmail — engagement nudge for prospects who paid for a
 * free TurfScan, opened their dashboard, but didn't click "Generate"
 * on the AI Coach card. Sent ~1 hour after `scan_engaged_at` if no
 * `ai_insights` row exists for their scan yet.
 *
 * Why this email exists: AI Coach is the upsell-bridge surface inside
 * the free TurfScan experience. Buyers who skip it never see the
 * personalized Fix List, never feel the "this tool understands my
 * business" moment, and almost certainly won't upgrade to the
 * Visibility Audit. The first real VIP buyer (Ryan / BVM Contracting,
 * May 12 2026) opened his map within 1s of conversion but never
 * clicked Generate — Stage 2 fired anyway and we lost a chance to
 * deepen engagement before pitching the audit.
 *
 * Tone: Anthony's voice, lowercase, conversational. The CTA points
 * at `/portal/{public_id}#ai-coach` so the page scrolls to the
 * Generate button on arrival. Magic-link auth re-issues if the
 * buyer's session has expired.
 *
 * Wired by: app/api/cron/ai-coach-nudge/route.ts (Vercel Cron, every
 * 15 minutes). The cron polls prospects for trigger conditions, joins
 * to lead_orders → clients → scans → ai_insights to filter out anyone
 * who already generated, and sends one email per qualifying prospect.
 */

import { Hr } from '@react-email/components';
import { EmailLayout, H1, P, PSmall, PrimaryButton } from './EmailLayout';

export type AICoachNudgeEmailProps = {
  firstName: string;
  businessName: string;
  /** /portal/{public_id}#ai-coach — scrolls to the Generate button. */
  dashboardUrl: string;
};

export default function AICoachNudgeEmail({
  firstName,
  businessName,
  dashboardUrl,
}: AICoachNudgeEmailProps) {
  return (
    <EmailLayout
      preview={`${firstName}, your ${businessName} playbook is one click away`}
    >
      <H1>your map is half the story</H1>

      <P>{firstName},</P>

      {/* Explicit {' '} tokens after interpolations / closing tags
       *  because JSX collapses the whitespace between a closing `}`
       *  or `</em>` and the next text node when they're separated by
       *  a newline + indentation. Without them the rendered HTML
       *  reads e.g. "Test Smoke Roofingbut" / "whereyour visibility".
       *  Lesson: when text wraps a JSX expression or inline element,
       *  always force the boundary space with {' '}. */}
      <P>
        i noticed you opened your TurfMap for {businessName}
        {' '}but didn&rsquo;t run the AI Coach yet. the heatmap shows
        you <em>where</em>{' '}your visibility is weak &mdash; the AI
        Coach is what turns that into a 3-step Fix List specific to
        your trade and your service area.
      </P>

      <P>
        it takes one click and about 20 seconds. no form, no call, no
        upsell. it just reads your scan data and tells you what to fix
        first, in order, with projected impact.
      </P>

      <PrimaryButton href={dashboardUrl}>
        Generate my Fix List &rarr;
      </PrimaryButton>

      <PSmall>
        if the link asks you to sign in, that&rsquo;s the magic-link
        flow &mdash; punch in the email you bought with and you&rsquo;ll
        be back at your map in under a minute.
      </PSmall>

      <Hr style={{ borderColor: '#1f1f1f', margin: '24px 0' }} />

      <P>&mdash; Anthony</P>
      <PSmall>Fourdots Digital</PSmall>
    </EmailLayout>
  );
}

// Subject line variants — cron rotates by a stable hash of the
// prospect id so a buyer never sees the same line twice if (against
// our idempotency) the nudge fires more than once.
export const SUBJECT_VARIANTS = [
  'your Fix List is one click away',
  'i noticed you didn’t run the AI Coach yet',
  'turn your TurfMap into a 3-step Fix List',
];

export function pickSubject(prospectId: string): string {
  let h = 0;
  for (const ch of prospectId) {
    h = (h * 31 + ch.charCodeAt(0)) | 0;
  }
  const idx = Math.abs(h) % SUBJECT_VARIANTS.length;
  return SUBJECT_VARIANTS[idx];
}
