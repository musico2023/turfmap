/**
 * Service-role Supabase client.
 *
 * Use ONLY in server-side code: route handlers, server components, scripts,
 * cron jobs. Never expose this to the browser — service_role bypasses RLS
 * and would let any caller read every client's data.
 *
 * For Phase 1 this is consumed exclusively by `scripts/test-scan.ts`.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function getServerSupabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL missing — check .env.local');
  }
  if (!key) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY missing — check .env.local');
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
