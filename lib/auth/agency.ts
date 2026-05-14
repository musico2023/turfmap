/**
 * Agency-side auth helpers.
 *
 * Two flavors:
 *   - `requireAgencyUserOrRedirect()` — for server components / pages.
 *     Calls Next's `redirect('/login')` if the visitor isn't a member of
 *     the `users` (agency staff) table. Throws — never returns null.
 *   - `requireAgencyUserForApi(req)` — for route handlers. Returns either
 *     the user record (continue) or a NextResponse 401/403 (return early).
 *
 * Both helpers use the cookie-bound auth client to read the active session,
 * then look up the email in the service-role client (so the membership
 * check is RLS-immune).
 *
 * Public routes that should never call these:
 *   /login, /portal/<id>, /portal/<id>/login, /auth/callback,
 *   /api/auth/*, /api/cron/* (uses Bearer secret), public homepage assets.
 */

import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/supabase/ssr';
import { getServerSupabase } from '@/lib/supabase/server';

export type AgencyUser = {
  id: string;
  email: string;
  full_name: string | null;
  role: 'admin' | 'manager' | 'analyst';
};

/**
 * Server-component / page helper. Redirects to /login on failure
 * (preserving `next=<current path>` if provided).
 */
export async function requireAgencyUserOrRedirect(
  nextPath?: string
): Promise<AgencyUser> {
  const user = await fetchAgencyUser();
  if (!user) {
    const next = nextPath ? `?next=${encodeURIComponent(nextPath)}` : '';
    redirect(`/login${next}`);
  }
  return user;
}

/**
 * API route handler helper. Returns the user OR a NextResponse the caller
 * should return immediately.
 */
export async function requireAgencyUserForApi(): Promise<
  AgencyUser | NextResponse
> {
  const user = await fetchAgencyUser();
  if (!user) {
    return NextResponse.json(
      { error: 'unauthorized — agency sign-in required' },
      { status: 401 }
    );
  }
  return user;
}

/**
 * Email domains belonging to the agency owner (Fourdots Digital).
 * Restricted-affordance actions — self-serve → agency conversion,
 * client deletion, future destructive ops — use this gate on top of
 * the standard agency-staff check, since these actions are
 * operationally significant and shouldn't be exposed to contractors
 * or future hires added to the `users` table from non-fourdots
 * emails. The base `users` table membership grants read + non-
 * destructive write access; this domain restricts the heavy stuff.
 */
const AGENCY_OWNER_DOMAINS = ['fourdots.ca', 'fourdots.io'];

/** True iff the email's domain is one of the agency-owner domains.
 *  Comparison is case-insensitive. NULL / empty / domainless inputs
 *  return false. */
export function isAgencyOwnerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const domain = email.split('@')[1]?.toLowerCase();
  return domain ? AGENCY_OWNER_DOMAINS.includes(domain) : false;
}

async function fetchAgencyUser(): Promise<AgencyUser | null> {
  const auth = await getAuthSupabase();
  const { data } = await auth.auth.getUser();
  const email = data.user?.email?.toLowerCase();
  if (!email) return null;

  const admin = getServerSupabase();
  const { data: row } = await admin
    .from('users')
    .select('id, email, full_name, role')
    .eq('email', email)
    .maybeSingle<AgencyUser>();
  return row ?? null;
}
