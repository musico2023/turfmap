/**
 * Sign-in magic-link email — sent when a user requests a fresh
 * sign-in link from /login or /portal/<id>/login. Different from
 * PortalInviteEmail (which is operator-initiated "you've been
 * added") in that the user actively asked for this link.
 *
 * The same template handles both agency-staff and portal-user
 * sign-ins; copy varies by the optional `businessName` parameter:
 *   - agency staff:  "Sign in to TurfMap" (no businessName)
 *   - portal user:   "Sign in to <Business>'s TurfMap dashboard"
 */

import {
  EmailLayout,
  H1,
  P,
  PSmall,
  PrimaryButton,
} from './EmailLayout';

export type SignInLinkEmailProps = {
  /** Magic-link URL — points at our /auth/callback with token_hash. */
  magicLinkUrl: string;
  /** When set, customizes the copy for a specific client portal.
   *  Null/undefined renders the agency-staff variant. */
  businessName?: string | null;
};

export function SignInLinkEmail({
  magicLinkUrl,
  businessName,
}: SignInLinkEmailProps) {
  const isPortal = Boolean(businessName);
  return (
    <EmailLayout
      preview={
        isPortal
          ? `Sign in to ${businessName}'s TurfMap dashboard`
          : 'Sign in to TurfMap'
      }
    >
      <H1>Your sign-in link</H1>
      <P>
        {isPortal ? (
          <>
            Click below to sign in to{' '}
            <strong>{businessName}</strong>&rsquo;s TurfMap dashboard.
          </>
        ) : (
          <>Click below to sign in to TurfMap.</>
        )}{' '}
        No password needed.
      </P>

      <PrimaryButton href={magicLinkUrl}>
        {isPortal ? 'Open my dashboard →' : 'Sign in →'}
      </PrimaryButton>

      <PSmall>
        This link expires in 24 hours and only works once. If you
        didn&rsquo;t request it, you can safely ignore this email.
      </PSmall>
    </EmailLayout>
  );
}
