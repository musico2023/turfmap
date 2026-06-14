/**
 * cancelUpsellRecoveryEmails — kill the scheduled Pulse-trial
 * recovery drip after the buyer subscribes.
 *
 * handleScoreUnlock schedules ONE recovery drip at unlock time:
 *
 *   pulse lane — 2 emails over the 72h extended-trial offer window
 *                (Resend ids stamped as
 *                pulse_recovery_touch_{1,2}_email_id)
 *
 * The audit-upgrade recovery lane (was 3 emails) was removed
 * 2026-06-13 per Anthony's page-only upsell policy: the audit
 * upgrade is a strict one-shot on /order/success and expires on
 * decline. Following up with reopen-link emails directly
 * contradicts the policy.
 *
 * Pulse stays — it's a separate independent decision from the
 * audit and the trial offer (60 days vs the standard 30) is
 * time-limited; nudges still make sense.
 *
 * Lookup: by client_id, we pull the score_unlock lead_orders row
 * (source='score_unlock', tier='scan'). Could be missing in two
 * cases: (a) the score_unlock webhook hasn't fired yet (race vs
 * the Pulse-conversion webhook), (b) this client didn't come
 * through the score_unlock funnel at all. Both cases no-op
 * silently.
 *
 * Best-effort throughout — Resend's cancellation API returns 404
 * for already-sent emails, which is the expected case when
 * conversion happens AFTER a touch has fired. We log and move on
 * rather than surface the cancellation to the buyer.
 */

import { cancelScheduledEmail } from '@/lib/email/resend';
import type { getServerSupabase } from '@/lib/supabase/server';

export type UpsellRecoveryLane = 'pulse';

const KEYS_BY_LANE: Record<UpsellRecoveryLane, readonly string[]> = {
  pulse: [
    'pulse_recovery_touch_1_email_id',
    'pulse_recovery_touch_2_email_id',
  ],
};

export async function cancelUpsellRecoveryEmails(
  supabase: ReturnType<typeof getServerSupabase>,
  clientId: string,
  lane: UpsellRecoveryLane
): Promise<{ ok: true; cancelled: number; alreadySent: number }> {
  const { data: row } = await supabase
    .from('lead_orders')
    .select('id, stripe_metadata')
    .eq('client_id', clientId)
    .eq('tier', 'scan')
    .order('created_at', { ascending: false })
    .limit(10)
    .returns<
      Array<{
        id: string;
        stripe_metadata: Record<string, unknown> | null;
      }>
    >()
    .then(({ data }) => {
      // Prefer the row that actually carries our recovery email ids.
      // A client can have multiple scan-tier lead_orders (preview +
      // fulfilled unlock); we want whichever one was stamped by the
      // score_unlock handler. Fallback to the most-recent row when
      // no match — defensive in case the metadata schema changes.
      const keys = KEYS_BY_LANE[lane];
      const stamped = (data ?? []).find((r) =>
        keys.some((k) => typeof r.stripe_metadata?.[k] === 'string')
      );
      return { data: stamped ?? (data?.[0] ?? null) };
    });

  if (!row?.stripe_metadata) {
    return { ok: true, cancelled: 0, alreadySent: 0 };
  }

  const keys = KEYS_BY_LANE[lane];
  let cancelled = 0;
  let alreadySent = 0;

  for (const key of keys) {
    const id = row.stripe_metadata[key];
    if (typeof id !== 'string' || !id) continue;
    try {
      const ok = await cancelScheduledEmail(id);
      if (ok) {
        cancelled++;
      } else {
        // cancelScheduledEmail returns false on 404 (email already
        // sent or unknown id) — counted as alreadySent so the caller
        // can log accurately without treating it as an error.
        alreadySent++;
      }
    } catch (e) {
      console.warn(
        `[cancel-recovery] ${lane} ${key} (${id}) cancellation threw:`,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  return { ok: true, cancelled, alreadySent };
}
