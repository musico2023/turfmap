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
        your citations across ~25 industry directories. Before we kick
        off the citation build for <strong>{businessName}</strong>, we
        need a few extra details — categories, hours, photos.
      </P>

      <PrimaryButton href={onboardingUrl}>
        Finish my setup →
      </PrimaryButton>

      <PSmall>
        First wave of citations goes live within 2 weeks of completing
        this form. Full propagation takes 6–8 weeks. We&rsquo;ll send
        progress updates as listings activate.
      </PSmall>
    </EmailLayout>
  );
}
