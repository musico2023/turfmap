/**
 * Canonical URL builders for TurfMap's two main app surfaces.
 *
 * Before this module existed, both URL patterns were rebuilt inline in
 * 20+ callsites across the API routes, crons, email templates, and
 * webhooks. That worked until the legacy /portal/<slug> URL flow
 * silently broke for buyers without provisioned `client_users` rows
 * (cold prospects who held emails for weeks, scan-tier paid buyers
 * who never got auto-provisioned). Audit + cleanup left this module
 * as the single source of truth so future routing changes — adding a
 * subdomain, changing the slug shape, swapping the path — land
 * exactly once.
 *
 * Convention:
 *   - portalUrl: BUYER surface, magic-link gated (/portal/<public_id>).
 *     Buyers paying $499+ get magic-link access here. Cold-outreach
 *     leads should NEVER be handed this URL — use a share URL instead.
 *   - agencyClientUrl: OPERATOR surface, agency-staff gated
 *     (/clients/<public_id>). Used in Slack pings, operator emails,
 *     and internal dashboards. Buyers should never see this URL.
 *
 * Both take an `origin` (eg. https://turfmap.ai) so they work in cron
 * contexts where `appOrigin()` is the right answer and in request
 * contexts where `req.headers.get('origin')` is the right answer.
 */

/**
 * Canonical, allowlisted app origin from NEXT_PUBLIC_APP_URL.
 *
 * Use this for EVERY credential-bearing or buyer-facing URL — magic-link
 * emails (token_hash), Stripe success/cancel URLs (CHECKOUT_SESSION_ID),
 * portal/dashboard links in emails. NEVER derive those from the request
 * `Origin` header: a forged request controls it, so an origin-built login
 * or checkout URL can point the token / session-id at an attacker domain
 * (account-takeover / fulfillment-hijack). Falls back to the prod host
 * only if the env is unset (preview/cron), which is still a safe,
 * non-attacker origin.
 */
export function appOrigin(): string {
  const env = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return (env && env.length > 0 ? env : 'https://www.turfmap.ai').replace(
    /\/+$/,
    ''
  );
}

/** Buyer-facing portal URL. Magic-link gated; requires a `client_users`
 *  row for the requesting email. Hand cold-outreach prospects a share
 *  URL instead — see /api/cron/ai-coach-nudge for the share-vs-portal
 *  fork pattern. */
export function portalUrl(origin: string, publicId: string): string {
  return `${origin}/portal/${publicId}`;
}

/** Agency-staff dashboard URL. Used in operator-facing Slack pings,
 *  internal emails, and the agency console. Never expose this in
 *  buyer-facing emails. */
export function agencyClientUrl(origin: string, publicId: string): string {
  return `${origin}/clients/${publicId}`;
}
