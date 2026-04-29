/**
 * Session-refresh middleware for /portal/* and /auth/* routes.
 *
 * Supabase auth uses short-lived JWTs that need refreshing on every request.
 * This middleware runs on the matched routes, calls `getUser()` (which
 * triggers refresh + cookie write when needed), and returns a response with
 * the updated cookies. Without this, sessions stop working a few minutes
 * after sign-in.
 *
 * Pattern is straight from the @supabase/ssr docs.
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Without env, fall through — the gate in the route handlers will
    // produce a clearer error than crashing the middleware.
    return response;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // CRITICAL: this call must happen here so Supabase has a chance to
  // refresh the access token. Don't remove without reading the @supabase/ssr
  // README first — silent session expiry is the failure mode.
  await supabase.auth.getUser();

  return response;
}
