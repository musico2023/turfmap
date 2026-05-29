/**
 * Idempotently ensure a `client_users` row exists for a buyer's email
 * on a client, so the buyer can magic-link sign in to their portal.
 *
 * Wired into the audit-initialization paths:
 *   - /api/orders/fulfill (audit-tier branch, right after the
 *     visibility_audits row is created)
 *   - lib/audit/bootstrapCompAudit (after createVisibilityAudit, same
 *     point as the NAP-audit auto-trigger)
 *
 * Why audit initialization (not earlier): paid audit / strategy buyers
 * are buying a $499+ deliverable they'll want ongoing access to via
 * the portal — Cal.com booking, scan-rerun history, AI Coach
 * regeneration, the works. Free scan buyers (organic /scan, COLDSCAN
 * bypass) view their data at /share/<id>; we don't want to over-
 * provision portal accounts they'll never use.
 *
 * Idempotent — re-runs are safe. The unique constraint on
 * (client_id, email) catches concurrent inserts; we treat 23505 as
 * "already existed" rather than an error.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

export type EnsurePortalUserResult =
  | { ok: true; alreadyExisted: boolean; clientUserId: string }
  | { ok: false; error: string };

export async function ensurePortalUser(
  supabase: SupabaseLike,
  clientId: string,
  email: string
): Promise<EnsurePortalUserResult> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !clientId) {
    return { ok: false, error: 'missing client_id or email' };
  }

  // Probe first — same pattern createVisibilityAudit uses. Saves an
  // INSERT round-trip + avoids a noisy PG log on the conflict path.
  const { data: existing } = await supabase
    .from('client_users')
    .select('id')
    .eq('client_id', clientId)
    .eq('email', normalized)
    .maybeSingle<{ id: string }>();
  if (existing?.id) {
    return { ok: true, alreadyExisted: true, clientUserId: existing.id };
  }

  // Insert. invited_at stamped to now() — the magic-link send + login
  // flow uses this as the "this email is on the access list" signal.
  // The buyer doesn't get a notification on insert; they only see the
  // sign-in surface when they hit /portal/<slug> themselves or get a
  // share link that points at the portal.
  const { data: inserted, error } = await supabase
    .from('client_users')
    .insert({
      client_id: clientId,
      email: normalized,
      invited_at: new Date().toISOString(),
    })
    .select('id')
    .single<{ id: string }>();

  if (error) {
    // Race: another concurrent ensurePortalUser slipped the insert in
    // between our probe and our insert. Re-probe so we still return a
    // usable client_users id.
    const code = (error as { code?: string }).code;
    if (code === '23505') {
      const { data: recovered } = await supabase
        .from('client_users')
        .select('id')
        .eq('client_id', clientId)
        .eq('email', normalized)
        .maybeSingle<{ id: string }>();
      if (recovered?.id) {
        return {
          ok: true,
          alreadyExisted: true,
          clientUserId: recovered.id,
        };
      }
    }
    return { ok: false, error: error.message };
  }

  return {
    ok: true,
    alreadyExisted: false,
    clientUserId: inserted.id,
  };
}
