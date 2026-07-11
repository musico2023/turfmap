/**
 * Pulse+ welcome — sent after a successful Pulse+ subscription
 * is created. Routes the buyer to the citation-onboarding form
 * (categories, hours, photos) needed for the listings-sync
 * integration (GHL Listings / Uberall as of 2026-07-11; formerly
 * BrightLocal Citation Builder).
 *
 * Operationally important: without those fields, listings can't
 * be distributed, so we surface the next-step CTA prominently +
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
        Pulse+ tracks your visibility weekly and keeps your business
        listings built + in sync across 70+ directories. Your first
        scan is on its way; in the meantime, your account team will
        reach out to gather the extra details we need for your
        listings profile (categories, hours, photos).
      </P>

      <PrimaryButton href={onboardingUrl}>
        View my dashboard →
      </PrimaryButton>

      <PSmall>
        Major platforms (Google, Apple Maps, Bing, Facebook) sync
        within days of providing those details. Full propagation
        across the long-tail directories takes 4–6 weeks — and your
        listings stay synced for as long as Pulse+ is active.
      </PSmall>
    </EmailLayout>
  );
}
