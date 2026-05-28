/**
 * Shared loaders for the Visibility Audit pipeline.
 *
 * These pull the buyer-specific summaries the AI Roadmap Generator
 * and Strategist Prep Notes generator both want as input:
 * NAP findings, competitor signals, geo-grid cell pattern.
 *
 * Originally lived in the audit-milestones cron. Now used by both
 * the cron (T-24h pre-call sweep) AND the fulfill route's
 * generate-roadmap-at-purchase path (lib/audit/generateAndStoreRoadmapPdf).
 * Same data shape, same null-tolerance.
 */

import { getServerSupabase } from '@/lib/supabase/server';
import type { ClientRow, ScanPointRow } from '@/lib/supabase/types';

export type SupabaseClientLike = ReturnType<typeof getServerSupabase>;

/** Format a market string for Roadmap copy + PDF header. Prefers
 *  city + region; falls back to the freeform address when geo
 *  components weren't parsed. */
export function formatMarket(client: ClientRow): string {
  const parts = [client.city, client.region].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : client.address ?? 'unknown market';
}

/** Compact NAP findings summary for the AI prompt. Production-side
 *  pull from nap_audits.findings JSON; returns null when no audit
 *  has run yet so the model handles the absent-data case. */
export async function loadNapFindingsSummary(
  supabase: SupabaseClientLike,
  clientId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('nap_audits')
    .select('findings')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ findings: unknown }>();
  if (!data?.findings) return null;
  try {
    return JSON.stringify(data.findings, null, 2).slice(0, 4000);
  } catch {
    return null;
  }
}

/** Competitor summary placeholder. The competitor_tracking table has
 *  the data but the summary-builder is a Phase-4 item; returning null
 *  is fine here — the AI prompt tolerates absent competitor input. */
export async function loadCompetitorSummary(
  _supabase: SupabaseClientLike,
  _scanId: string
): Promise<string | null> {
  return null;
}

/** One-line cell-pattern summary so the AI prompt has a quick read
 *  on how visible the buyer is. Returns null when scan_points is
 *  empty (failed scan or pre-fulfillment). */
export async function loadCellPatternSummary(
  supabase: SupabaseClientLike,
  scanId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('scan_points')
    .select('rank')
    .eq('scan_id', scanId);
  if (!data || data.length === 0) return null;
  const inPack = data.filter((p) => p.rank != null && p.rank <= 3).length;
  const total = data.length;
  const reach = total > 0 ? Math.round((inPack / total) * 100) : 0;
  return `Buyer appears in ${inPack} of ${total} cells (${reach}% TurfReach).`;
}

/** Load the structured 9×9 cell array for the Roadmap PDF's heatmap
 *  page. Returns [] on missing data — the PDF tolerates an empty
 *  cells array and renders an "Awaiting scan" placeholder. */
export async function loadCellsForScan(
  supabase: SupabaseClientLike,
  scanId: string
): Promise<Array<{ x: number; y: number; rank: number | null }>> {
  const { data } = await supabase
    .from('scan_points')
    .select('grid_x, grid_y, rank')
    .eq('scan_id', scanId);
  if (!data) return [];
  return (data as Pick<ScanPointRow, 'grid_x' | 'grid_y' | 'rank'>[]).map(
    (p) => ({ x: p.grid_x, y: p.grid_y, rank: p.rank })
  );
}
