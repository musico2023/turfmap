/**
 * Server-side cold-funnel event logger. Mirrors the design of
 * landerVisits.ts (same scanner-bot UA filter, same fire-and-forget
 * pattern, same service-role insert) but writes typed funnel events
 * to cold_funnel_events (migration 0041) instead of page-view rows.
 *
 * Why both tables exist:
 *   ops_lander_visits is purposely scoped to a single event (page
 *   load). The cold-email brief asks for a multi-step funnel
 *   (yourmap_view → scroll_50 → scroll_form → cta_click →
 *   free_scan_started → free_scan_completed) keyed by prospect_id
 *   + campaign. Conflating scroll milestones and CTA clicks with
 *   page views in ops_lander_visits would muddy that table's
 *   semantics. cold_funnel_events takes the multi-event role.
 *
 * Bot filtering:
 *   Drops enterprise email-security scanners (SafeLinks, Proofpoint,
 *   Mimecast, etc.) and social-card unfurlers BEFORE the insert. The
 *   regex set is duplicated from landerVisits.ts on purpose — if a
 *   new scanner shows up in production we want to be able to fix
 *   each table's filter independently, not couple them via shared
 *   import (which has historically caused "I fixed the lander filter
 *   but the funnel still over-counts" surprises in similar shared-
 *   filter setups elsewhere).
 *
 * Fire-and-forget:
 *   Must NEVER block request paths. The insert promise is intentionally
 *   not awaited; a .then() catch hooks any error to console.warn so
 *   unhandled-rejection doesn't surface. This matters most for
 *   POST /api/funnel/track — clients on slow networks would otherwise
 *   feel the round-trip latency.
 */

import { getServerSupabase } from '@/lib/supabase/server';
import { fireScanViewedFanout } from '@/lib/analytics/scanViewedFanout';

export type FunnelEventType =
  | 'yourmap_view'
  | 'yourmap_scroll_50'
  | 'yourmap_scroll_form'
  | 'coldscan_cta_click'
  | 'free_scan_started'
  | 'free_scan_completed';

export type FunnelEventInput = {
  event_type: FunnelEventType;
  prospect_id?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  user_agent?: string | null;
  referer?: string | null;
};

/**
 * Email-security scanner + social-unfurler UA patterns. Calibrated
 * against the major enterprise-email-security vendors and link-
 * preview bots we observed pre-fetching cold-email URLs on
 * 2026-05-14. Kept in sync with landerVisits.ts but intentionally
 * NOT shared via import (see module header for the reasoning).
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
  // Bare X11 Linux WebKit with no Chrome/Firefox/Edge token —
  // characteristic of headless scanners (Microsoft SafeLinks proxy
  // variants, generic Puppeteer/Playwright). Real Linux browsers
  // always include a recognizable browser token.
  if (/X11; Linux x86_64/.test(ua) && !/(Chrome|Firefox|Edge)\//.test(ua)) {
    return true;
  }
  return false;
}

/**
 * Public entry point. Fire-and-forget; the caller MUST NOT await this
 * in a critical request path. Returns void (not Promise<void>) on
 * purpose so the type signature actively discourages awaiting.
 */
export function logFunnelEvent(input: FunnelEventInput): void {
  // Bot filter applies to events with a user_agent. Server-side
  // events from preview-init / share render typically pass
  // user_agent=null (they're not browser-originated requests) and
  // pass through unfiltered, which is correct — we want every
  // scan_started + scan_completed regardless of who started it.
  if (input.user_agent && looksLikeScanner(input.user_agent)) {
    return;
  }

  try {
    const supabase = getServerSupabase();
    void supabase
      .from('cold_funnel_events')
      .insert({
        event_type: input.event_type,
        prospect_id: input.prospect_id ?? null,
        utm_source: input.utm_source ?? null,
        utm_medium: input.utm_medium ?? null,
        utm_campaign: input.utm_campaign ?? null,
        user_agent: input.user_agent ?? null,
        referer: input.referer ?? null,
      })
      .then(({ error }) => {
        if (error) {
          console.warn(
            '[funnelEvents] insert failed:',
            input.event_type,
            error.message
          );
        }
      });
  } catch (e) {
    // Defensive: a missing service-role env in dev shouldn't
    // bomb the lander render. Log + move on.
    console.warn(
      '[funnelEvents] insert threw:',
      input.event_type,
      e instanceof Error ? e.message : String(e)
    );
  }

  // Fan-out side-effects for high-signal events (v2.2 §P0.2). Only
  // yourmap_view fans out for now (P0.2a = Slack ping). GHL upsert
  // (P0.2b) and SMS trigger (P0.2c) will attach to this same branch
  // when they land. Fire-and-forget; the fanout function is void.
  if (input.event_type === 'yourmap_view') {
    fireScanViewedFanout(input.prospect_id ?? null);
  }
}
