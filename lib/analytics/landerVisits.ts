/**
 * Server-side lander-visit logger for the LLM Ops Dashboard
 * (llm.fourdots.io). Used by /yourmap to record clicks from cold-email
 * prospects so the dashboard's funnel "Clicks" step is accurate without
 * Instantly URL-rewrite click tracking (which is intentionally disabled
 * for deliverability).
 *
 * Fire-and-forget — must NEVER block the page render. Failures are
 * logged to stderr only.
 *
 * Caller is expected to only invoke this for actual prospect clicks
 * (e.g. only when prospect_id is present). The table itself doesn't
 * enforce that.
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

export function logLanderVisit(input: LanderVisitInput): void {
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
        if (error) console.warn('[landerVisits] insert failed:', error.message);
      });
  } catch (err) {
    console.warn('[landerVisits] unexpected error (swallowed):', err);
  }
}
