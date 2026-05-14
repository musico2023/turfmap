/**
 * Pulse+ welcome — sent after a successful Pulse+ subscription
 * is created. Routes the buyer to the citation-onboarding form
 * (categories, hours, photos) needed for the BrightLocal Citation
 * Builder integration.
 *
 * Operationally important: without those fields, citations can't
 * be submitted, so we surface the next-step CTA prominently +
 * give the buyer concrete expectations on what they're filling
 * out and why.
 */

import {
  EmailLayout,
  H1,
  P,
  PSmall,
  PrimaryButton,
  TierBadge,
} from './EmailLayout';

export type PulsePlusWelcomeEmailProps = {
  businessName: string;
  onboardingUrl: string;
};

export function PulsePlusWelcomeEmail({
  businessName,
  onboardingUrl,
}: PulsePlusWelcomeEmailProps) {
  return (
    <EmailLayout preview={`Welcome to Pulse+ — finish your setup`}>
      <P>
        <TierBadge tier="pulse_plus" />
      </P>
      <H1>Welcome to Pulse+.</H1>
      <P>
        Pulse+ tracks your visibility weekly and builds + maintains
        your citations across ~25 industry directories. Your first
        scan is on its way; in the meantime, your account team will
        reach out to gather the extra details we need for the
        citation build (categories, hours, photos).
      </P>

      <PrimaryButton href={onboardingUrl}>
        View my dashboard →
      </PrimaryButton>

      <PSmall>
        First wave of citations goes live within 2 weeks of providing
        those details. Full propagation takes 6–8 weeks. We&rsquo;ll
        send progress updates as listings activate.
      </PSmall>
    </EmailLayout>
  );
}
