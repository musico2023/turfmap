/**
 * Browser / anon-key Supabase client.
 *
 * Safe to use in client components. Subject to Row Level Security.
 * Phase 1 doesn't actually use this yet (no UI), but it's stubbed so the
 * dashboard work in Phase 2 can import from a stable path.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function getBrowserSupabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY missing — check .env.local'
    );
  }

  cached = createClient(url, anonKey);
  return cached;
}
