/**
 * POST /api/auth/signout — sign the current user out and clear the session
 * cookie. The browser then 302s to the originating portal's login page.
 */

import { NextResponse } from 'next/server';
import { getAuthSupabase } from '@/lib/supabase/ssr';

export const runtime = 'nodejs';

export async function POST() {
  const auth = await getAuthSupabase();
  await auth.auth.signOut();
  return NextResponse.json({ ok: true });
}
