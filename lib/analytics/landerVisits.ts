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
