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
import type { ClientRow, NapAuditFindings, ScanPointRow } from '@/lib/supabase/types';

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
    return summarizeNapFindingsForPrompt(data.findings);
  } catch {
    return null;
  }
}

/** Frame nap_audit findings for an AI prompt WITHOUT leaking the raw
 *  null NAP fields that the dump used to expose.
 *
 *  Why: a directory citation is matched by NAME, but its phone/address are
 *  read only from the Google SERP snippet — so they're routinely null even
 *  when the listing displays them on-page (Facebook came back phone:null
 *  while the page showed (403) 220-1515). Dumping the raw JSON let the AI
 *  read "phone": null as "this listing has no phone" and recommend adding a
 *  phone to a listing that already has one. We list found vs not-surfaced
 *  directories + real inconsistencies, and teach the model that a blank
 *  phone/address on a FOUND listing is a read limitation, not a gap. */
export function summarizeNapFindingsForPrompt(findings: unknown): string {
  const f = (findings ?? {}) as Partial<NapAuditFindings>;
  const found = (f.citations ?? [])
    .map((c) => c?.directory)
    .filter((d): d is string => Boolean(d));
  const missing = f.missing ?? [];
  const inc = (f.inconsistencies ?? []).filter((i) => i?.directory);

  // Label a missing entry: sibling-occupied entries name the sibling.
  const labelMissing = (m: NapAuditFindings['missing'][number]) =>
    m.occupied_by_sibling
      ? `${m.directory} (sibling "${m.occupied_by_sibling.sibling_label ?? 'unknown'}" already listed at ${m.occupied_by_sibling.sibling_address ?? 'unknown address'})`
      : m.directory;

  const missingHigh = missing.filter((m) => m.priority === 'high');
  const missingMedium = missing.filter((m) => m.priority === 'medium');
  const missingLow = missing.filter((m) => m.priority === 'low');

  const missRows =
    missing.length === 0
      ? 'none'
      : [
          missingHigh.length > 0
            ? `  high-priority: ${missingHigh.slice(0, 10).map(labelMissing).join(', ')}${missingHigh.length > 10 ? `, …+${missingHigh.length - 10}` : ''}`
            : null,
          missingMedium.length > 0
            ? `  medium-priority: ${missingMedium.slice(0, 10).map(labelMissing).join(', ')}${missingMedium.length > 10 ? `, …+${missingMedium.length - 10}` : ''}`
            : null,
          missingLow.length > 0
            ? `  low-priority (sibling already listed): ${missingLow.slice(0, 10).map(labelMissing).join(', ')}${missingLow.length > 10 ? `, …+${missingLow.length - 10}` : ''}`
            : null,
        ]
          .filter(Boolean)
          .join('\n');

  const lines: string[] = [];
  lines.push(
    `Directory listings FOUND (listing exists, name verified): ${found.length ? found.join(', ') : 'none'}`
  );
  lines.push(`Not surfaced by the search probe:`);
  lines.push(missRows);
  if (inc.length) {
    lines.push('NAP field conflicts vs the canonical Google Business Profile:');
    for (const i of inc.slice(0, 8)) {
      lines.push(
        `  - ${i.directory} [${i.field ?? 'NAP'}]: directory shows "${i.found ?? '?'}" vs canonical "${i.canonical ?? '?'}"`
      );
    }
  } else {
    lines.push('NAP field conflicts vs canonical: none detected.');
  }
  lines.push('');
  lines.push('HOW TO READ THIS (important — do not misread):');
  lines.push(
    '- "Found" means the listing exists and its NAME matches. Phone and address are read only from the Google search snippet, so they are usually blank even when the listing clearly displays them on its page. A blank phone/address here means "not shown in search results" — NOT that the listing lacks one.'
  );
  lines.push(
    '- Never recommend "add a phone number or address to <directory>", and never state that a FOUND listing is missing NAP fields — that is not something this audit can verify.'
  );
  lines.push(
    '- "Not surfaced by the search probe" means our automated search did not find a listing; it does NOT prove the business has none there. Frame these as "confirm, and claim only if genuinely absent."'
  );
  return lines.join('\n').slice(0, 4000);
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
