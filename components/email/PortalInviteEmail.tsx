/**
 * Portal-user invite — the magic-link email recipients get when
 * the operator adds them to a client's portal access list. Uses
 * Supabase admin.generateLink so the recipient's browser doesn't
 * need a PKCE verifier.
 */

import {
  EmailLayout,
  H1,
  P,
  PSmall,
  PrimaryButton,
} from './EmailLayout';

export type PortalInviteEmailProps = {
  businessName: string;
  /** Supabase magic-link URL from admin.generateLink({ type: 'magiclink' }). */
  magicLinkUrl: string;
};

export function PortalInviteEmail({
  businessName,
  magicLinkUrl,
}: PortalInviteEmailProps) {
  return (
    <EmailLayout
      preview={`You're invited to view ${businessName}'s TurfMap`}
    >
      <H1>You&rsquo;re invited.</H1>
      <P>
        <strong>{businessName}</strong>{' '}has shared their local-visibility
        dashboard with you — geo-grid heatmaps, score movement over time,
        competitor analysis, and a strategist-grade AI Coach playbook.
      </P>
      <P>Click the button below to sign in. No password needed.</P>

      <PrimaryButton href={magicLinkUrl}>
        Open my dashboard →
      </PrimaryButton>

      <PSmall>
        This link expires in 24 hours. If it stops working, ask{' '}
        {businessName}&rsquo;s account manager for a fresh one.
      </PSmall>
    </EmailLayout>
  );
}
