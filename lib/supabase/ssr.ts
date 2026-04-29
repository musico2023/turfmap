/**
 * Anon-key Supabase client for server components and route handlers that
 * need access to the *current user's* session (cookie-bound).
 *
 * For service-role server work (cron jobs, scripts, agency-side data
 * fetching where RLS doesn't apply), use `getServerSupabase()` from
 * `./server`. The two clients have different keys and different rules.
 */

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function getAuthSupabase() {
  const cookieStore = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY missing — check .env.local'
    );
  }
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // This is allowed to fail in Server Components — the response is
          // already streaming. The middleware refreshes cookies on each
          // request, so a missed write here is recovered on the next call.
        }
      },
    },
  });
}
