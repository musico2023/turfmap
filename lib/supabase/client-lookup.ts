/**
 * Tolerant client lookup helper.
 *
 * Every user-facing URL now passes a 10-char `public_id` instead of the
 * full UUID. But we keep accepting UUIDs at every entry point so:
 *   - Old bookmarks / shared links don't 404
 *   - The Supabase Studio table editor (where operators paste UUIDs)
 *     still works
 *   - The migration is non-breaking
 *
 * Resolution rule: if the param looks like a UUID (36 chars with the
 * standard 8-4-4-4-12 hyphenation), look up by `id`; otherwise look up
 * by `public_id`. Returns the full clients row or null.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClientRow } from '@/lib/supabase/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidShape(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Look up a client by either its UUID id or its short public_id. Returns
 * null when nothing matches. The route handler / page wrapper should
 * call notFound() on null (or surface a 404 JSON envelope).
 */
export async function findClientByPublicIdOrUuid(
  supabase: SupabaseLike,
  param: string
): Promise<ClientRow | null> {
  const column = isUuidShape(param) ? 'id' : 'public_id';
  const { data } = await supabase
    .from('clients')
    .select('*')
    .eq(column, param)
    .maybeSingle<ClientRow>();
  return data ?? null;
}

/**
 * Resolve a route param to the canonical client UUID without loading the
 * full row. Returns null when nothing matches. Useful for routes that
 * only need the UUID for FK lookups (locations, scans, audits, etc.)
 * and don't actually use the clients row's other fields.
 */
export async function resolveClientUuid(
  supabase: SupabaseLike,
  param: string
): Promise<string | null> {
  if (isUuidShape(param)) return param; // already a UUID — assume it's valid;
  // upstream FK lookups will fail safely if not.
  const { data } = await supabase
    .from('clients')
    .select('id')
    .eq('public_id', param)
    .maybeSingle<{ id: string }>();
  return data?.id ?? null;
}
