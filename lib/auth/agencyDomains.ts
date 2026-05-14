/**
 * Agency-staff email domain check.
 *
 * Single source of truth for "is this email a Fourdots staff address?".
 * Used by:
 *   - /api/auth/agency-magic-link to gate sign-in link issuance (only
 *     Fourdots-domain emails can request a TurfMap login link; clients
 *     come in through their per-portal magic link instead).
 *   - lib/scans/rateLimit to skip the on-demand scan cap for staff
 *     (we need to be able to fire scans freely during sales demos and
 *     onboarding without burning the rolling-24h window).
 *
 * Domain-based (not email-based) so adding a new staff member doesn't
 * require updating this list — they get access by virtue of having an
 * agency email. Both .io and .ca are included since Fourdots actively
 * uses both addresses.
 */

export const AGENCY_DOMAINS: ReadonlySet<string> = new Set([
  'fourdots.io',
  'fourdots.ca',
]);

export function isAgencyDomainEmail(
  email: string | null | undefined
): boolean {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return AGENCY_DOMAINS.has(domain);
}
