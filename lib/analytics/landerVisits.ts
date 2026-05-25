/**
 * Server-side lander-visit logger for the LLM Ops Dashboard
 * (llm.fourdots.io). Used by /yourmap, /fourdots, /freescan to record
 * acquisition-lander loads — the dashboard counts "clicks" per channel
 * from this table without relying on Instantly's URL-rewrite click
 * tracker (intentionally disabled for deliverability).
 *
 * The dashboard reads this table directly. We write via service-role.
 * Fire-and-forget — must NEVER block the page render. Failures are
 * logged to stderr only.
 *
 * For prospect-keyed channels (/yourmap), caller is expected to only
 * invoke when prospect_id is present. The table itself doesn't enforce.
 *
 * Scanner-UA filter (looksLikeScanner) drops requests from email-
 * security gateways (Microsoft SafeLinks, Proofpoint, Mimecast,
 * Barracuda, etc.) and social-card unfurlers (Slack / Twitter /
 * LinkedIn / WhatsApp / Facebook). These pre-fetch links inside
 * incoming emails to check for malicious URLs but are not real
 * human visits and don't execute JavaScript. We observed this
 * pollute the count on 2026-05-14 — one cold-email recipient (Air
 * Point Heating, behind enterprise email security) showed up as
 * 22 visits in 12 hours, when realistically it was 1 human +
 * 21 scanner pre-fetches.
 */

import { getServerSupabase } from '@/lib/supabase/server';

export type LanderVisitInput = {
  path: string;                        // e.g. '/yourmap'
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  coupon?: string | null;
  prospect_id?: string | null;
  user_agent?: string | null;
  referer?: string | null;
};

/**
 * Email-security scanner + social-unfurler UA patterns we drop
 * before inserting. Calibrated against major enterprise email
 * security vendors + common link-preview bots.
 *
 * Conservative — when in doubt we log (false negatives in the
 * filter just inflate the count slightly, which is fine; false
 * positives would silently drop real clicks). The list is
 * intentionally regex'd to be tolerant of vendor sub-products and
 * version strings.
 */
const SCANNER_UA_PATTERNS: readonly RegExp[] = [
  /microsoft.*safelink/i,
  /atp(?:safelinks)?/i,
  /proofpoint/i,
  /mimecast/i,
  /symantec/i,
  /forcepoint/i,
  /barracuda/i,
  /trendmicro/i,
  /ironport/i,
  /spamtitan/i,
  /appriver/i,
  /retarus/i,
  /clearswift/i,
  /sophos.*sandstorm/i,
  /\bbot\b/i,
  /crawler/i,
  /spider/i,
  /headlesschrome/i,
  /phantomjs/i,
  /slackbot/i,
  /facebookexternalhit/i,
  /twitterbot/i,
  /linkedinbot/i,
  /whatsapp/i,
  /telegrambot/i,
  // Generic HTTP clients — observed in cold-email lander logs as
  // pre-fetches from email-security gateways (2026-05-25 audit).
  /go-http-client/i,
  /python-requests/i,
  /\bcurl\//i,
  /\bwget\//i,
  /\bjava\//i,
  /okhttp/i,
];

function looksLikeScanner(ua: string | null | undefined): boolean {
  if (!ua) return false;
  if (SCANNER_UA_PATTERNS.some((re) => re.test(ua))) return true;
  // Bare Linux WebKit fingerprint with no Chrome/Firefox/Edge version
  // suffix — characteristic of headless scanners (Microsoft SafeLinks
  // proxy variants, generic Puppeteer/Playwright). Real Linux browsers
  // always include a Chrome/, Firefox/, or Edge/ token.
  if (/X11; Linux x86_64/.test(ua) && !/(Chrome|Firefox|Edge)\//.test(ua)) {
    return true;
  }
  return false;
}

export function logLanderVisit(input: LanderVisitInput): void {
  // Drop scanner / preview-bot pre-fetches BEFORE the insert so the
  // dashboard's "Clicks" number reflects real-human clicks instead
  // of inflating on enterprise email security pre-fetches. See the
  // module header for the Air Point Heating incident (May 14)
  // that motivated this filter.
  if (looksLikeScanner(input.user_agent)) {
    return;
  }

  // Don't block page render. The promise is intentionally not awaited;
  // we attach a catch so unhandled-rejection doesn't surface.
  try {
    const supabase = getServerSupabase();
    void supabase
      .from('ops_lander_visits')
      .insert({
        path:         input.path,
        utm_source:   input.utm_source ?? null,
        utm_medium:   input.utm_medium ?? null,
        utm_campaign: input.utm_campaign ?? null,
        coupon:       input.coupon ?? null,
        prospect_id:  input.prospect_id ?? null,
        user_agent:   input.user_agent ?? null,
        referer:      input.referer ?? null,
      })
      .then(({ error }) => {
        if (error) {
          // Log to stderr; lander render is unaffected.
          console.warn('[landerVisits] insert failed:', error.message);
        }
      });
  } catch (err) {
    console.warn('[landerVisits] unexpected error (swallowed):', err);
  }
}
