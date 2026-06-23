/**
 * Shared TurfMap AI Coach insight generation.
 *
 * Loads a complete scan, builds the prompt context (9×9 grid, competitor
 * leaderboard, NAP audit findings, GBP signals, score history, sibling
 * locations), calls Anthropic Sonnet with structured Zod output, and
 * persists the result to ai_insights.
 *
 * Two callers today:
 *   - /api/ai/insights — operator-triggered via the AICoachGenerateButton
 *     on the agency console. Agency auth, full 240s NAP-audit wait budget.
 *   - /api/yourmap/coldscan-fulfill — pre-generates the Fix List for
 *     cold-cohort buyers before they hit /share/[id], where there's no
 *     Generate button (public surface, no agency auth available).
 *     Tighter NAP-audit wait budget since the fulfill route has already
 *     burned ~30-60s on the scan itself.
 *
 * Caller responsibilities:
 *   - Auth (operator route checks agency session; coldscan-fulfill trusts
 *     its own prospect_id gate).
 *   - Surfacing the structured error to the right HTTP status.
 */

import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { COACH_MODEL, getAnthropic } from '@/lib/anthropic/client';
import {
  TURF_COACH_PROMPT_VERSION,
  TURF_COACH_SYSTEM_PROMPT,
  TurfCoachInsight,
  buildTurfCoachUserPrompt,
} from '@/lib/anthropic/prompts/turfCoach';
import { turfReach } from '@/lib/metrics/turfReach';
import { turfRank } from '@/lib/metrics/turfRank';
import { MIN_SHARE_PCT } from '@/lib/metrics/competitors';
import {
  maybeFinalizeNapAudit,
  maybeRunNapAudit,
} from '@/lib/brightlocal/autoAudit';
import {
  listLocations,
  locationDisplayLabel,
  resolveLocation,
} from '@/lib/supabase/locations';
import { getLatestSignals } from '@/lib/google/enrich';
import type { GbpSignalsContext } from '@/lib/anthropic/prompts/turfCoach';
import type {
  ClientRow,
  ScanRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

export type AICoachAction = {
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  action: string;
  why: string;
};

export type GenerateInsightOk = {
  ok: true;
  id: string;
  scanId: string;
  diagnosis: string;
  actions: AICoachAction[];
  projectedImpact: string | null;
  model: string;
  promptVersion: string;
};

export type GenerateInsightErr = {
  ok: false;
  error: string;
  /** Suggested HTTP status the wrapping route should surface. */
  status: number;
};

export type GenerateInsightResult = GenerateInsightOk | GenerateInsightErr;

export type GenerateInsightOptions = {
  /**
   * Max milliseconds to wait for an in-flight NAP audit to complete
   * before proceeding without its findings. Default 240_000 (matches
   * the operator route's full 300s budget minus ~50s headroom for the
   * Anthropic call). Set lower when the caller already burned route
   * time before calling this — e.g. coldscan-fulfill awaits the scan
   * first and passes 90_000 to stay inside the 300s maxDuration.
   */
  napAuditWaitMs?: number;
};

/**
 * Generate the AI Coach playbook for a scan, persist to ai_insights,
 * and return the structured insight. See file header for caller
 * conventions + auth responsibilities.
 */
export async function generateInsight(
  supabase: SupabaseLike,
  scanId: string,
  triggeredBy: string | null,
  options: GenerateInsightOptions = {}
): Promise<GenerateInsightResult> {
  const napAuditWaitMs = options.napAuditWaitMs ?? 240_000;

  // 1. Load the scan, client, keyword
  const { data: scan } = await supabase
    .from('scans')
    .select('*')
    .eq('id', scanId)
    .maybeSingle<ScanRow>();
  if (!scan) return { ok: false, error: 'scan not found', status: 404 };
  if (scan.status !== 'complete') {
    return {
      ok: false,
      error: `scan status is "${scan.status}" — only complete scans can be analyzed`,
      status: 409,
    };
  }

  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('id', scan.client_id)
    .maybeSingle<ClientRow>();
  const { data: keyword } = await supabase
    .from('tracked_keywords')
    .select('*')
    .eq('id', scan.keyword_id)
    .maybeSingle<TrackedKeywordRow>();
  if (!client || !keyword) {
    return {
      ok: false,
      error: 'client or keyword missing for this scan',
      status: 500,
    };
  }

  // Resolve the location this scan was run against. Multi-location
  // clients have one location per scan; legacy scans without a
  // location_id fall back to the client's primary.
  const scanLocation = await resolveLocation(
    supabase,
    client.id,
    scan.location_id ?? null
  );

  // 2. Pull scan_points + build the 9×9 client rank grid + observed
  //    competitor leaderboard (top 10 by appearance count).
  const { data: rawPoints } = await supabase
    .from('scan_points')
    .select('grid_x, grid_y, rank, competitors')
    .eq('scan_id', scan.id);
  const points = rawPoints ?? [];

  const rankGrid: Array<Array<number | null>> = Array.from({ length: 9 }, () =>
    Array<number | null>(9).fill(null)
  );
  for (const p of points) {
    const x = p.grid_x as number;
    const y = p.grid_y as number;
    if (y >= 0 && y < 9 && x >= 0 && x < 9) {
      rankGrid[y][x] = (p.rank as number | null) ?? null;
    }
  }

  // Top competitors — same dedupe + noise-filter logic as the dashboard
  // CompetitorTable. See /api/ai/insights for the rationale.
  const ownNamePattern = new RegExp(
    client.business_name.split(/\s+/)[0] ?? '',
    'i'
  );
  type Stats = { ranks: number[] };
  const compStats = new Map<string, Stats>();
  for (const p of points) {
    const list = (p.competitors ?? []) as Array<{
      name: string | null;
      rank_group: number | null;
      rank_absolute: number | null;
    }>;
    const cellBest = new Map<string, number>();
    for (const c of list) {
      if (!c?.name) continue;
      if (ownNamePattern.test(c.name)) continue;
      const rank = c.rank_group ?? c.rank_absolute ?? null;
      if (rank === null || rank > 3) continue;
      const prev = cellBest.get(c.name);
      if (prev === undefined || rank < prev) cellBest.set(c.name, rank);
    }
    for (const [name, rank] of cellBest.entries()) {
      const s = compStats.get(name) ?? { ranks: [] };
      s.ranks.push(rank);
      compStats.set(name, s);
    }
  }
  const totalPointsForShare = Math.max(points.length, 1);
  const competitorList = [...compStats.entries()]
    .map(([name, s]) => ({
      name,
      appearances: s.ranks.length,
      avgRank: s.ranks.reduce((a, b) => a + b, 0) / s.ranks.length,
      bestRank: Math.min(...s.ranks),
      sharePct: Math.round((s.ranks.length / totalPointsForShare) * 100),
    }))
    .filter((c) => c.sharePct >= MIN_SHARE_PCT)
    .sort((a, b) => b.appearances - a.appearances || a.avgRank - b.avgRank)
    .slice(0, 10);

  // Score family — defensive recompute if persisted columns are null.
  const ranksFromPoints = points.map(
    (p) => (p.rank as number | null) ?? null
  );
  const reach =
    scan.turf_reach != null
      ? Number(scan.turf_reach)
      : turfReach(ranksFromPoints, scan.total_points ?? 81);
  const rank =
    scan.turf_rank != null ? Number(scan.turf_rank) : turfRank(ranksFromPoints);
  const compositeScore =
    scan.turf_score != null ? Number(scan.turf_score) : null;

  // NAP audit grounding (self-healing), scoped to the scan's LOCATION.
  // trigger_source='ai-coach' distinguishes self-heal triggers from
  // post-scan auto-fires + audit-init bootstraps (migration 0040).
  await maybeRunNapAudit(
    supabase,
    client.id,
    triggeredBy,
    scanLocation?.id ?? null,
    'ai-coach'
  );
  const napAudit = await maybeFinalizeNapAudit(supabase, client.id, {
    waitForReadyMs: napAuditWaitMs,
    locationId: scanLocation?.id ?? null,
  });

  // Composed business label so the prompt knows WHICH storefront it's
  // reasoning about (multi-location clients).
  const businessLabel = scanLocation
    ? `${client.business_name} (${locationDisplayLabel(scanLocation)})`
    : client.business_name;
  const serviceArea =
    scanLocation?.address ?? client.address ?? '(unknown service area)';
  const gridRadiusMiles = Number(
    scanLocation?.service_radius_miles ??
      client.service_radius_miles ??
      1.6
  );

  // Sibling locations: every other location of the same brand.
  const allLocations = scanLocation
    ? await listLocations(supabase, client.id)
    : [];
  const siblingLocations = allLocations
    .filter((l) => l.id !== scanLocation?.id)
    .map((l) => ({
      label: locationDisplayLabel(l),
      address: l.address ?? '(no address)',
    }));

  // Score history — last ~7 distinct days for THIS location + keyword.
  const { data: historyRows } = scanLocation
    ? await supabase
        .from('scans')
        .select('completed_at, turf_score')
        .eq('client_id', client.id)
        .eq('location_id', scanLocation.id)
        .eq('keyword_id', keyword.id)
        .eq('status', 'complete')
        .not('turf_score', 'is', null)
        .order('completed_at', { ascending: false })
        .limit(30)
        .returns<Array<{ completed_at: string; turf_score: number }>>()
    : { data: null };
  const byDay = new Map<string, number>();
  for (const r of historyRows ?? []) {
    if (!r.completed_at || r.turf_score == null) continue;
    const date = r.completed_at.slice(0, 10);
    if (!byDay.has(date)) {
      byDay.set(date, Number(r.turf_score));
    }
  }
  const scoreHistory = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-7)
    .map(([date, score]) => ({ date, score }));

  // GBP signals — latest Google Places snapshot for this location.
  const gbpSignals: GbpSignalsContext | null = scanLocation
    ? await (async () => {
        const matchStatus = scanLocation.google_place_match_status;
        if (matchStatus === 'rejected' || matchStatus === 'no_match') {
          return null;
        }
        const row = await getLatestSignals(supabase, scanLocation.id);
        if (!row) return null;
        const hours = row.regular_opening_hours as
          | { weekdayDescriptions?: string[] }
          | null;
        return {
          rating: row.rating,
          reviewCount: row.user_ratings_total,
          primaryType: row.primary_type,
          types: row.types,
          businessStatus: row.business_status,
          photosCount: row.photos_count,
          hoursSummary: hours?.weekdayDescriptions ?? null,
          editorialSummary: row.editorial_summary,
          fetchedAt: row.fetched_at,
        };
      })()
    : null;

  // Review velocity — the RATE of new reviews, derived from gbp_signals
  // count snapshots over time. The single highest-leverage prominence lever;
  // a static total tells the coach nothing about whether the review profile
  // is growing or stale. null when <2 snapshots or too short a span.
  const reviewVelocity = scanLocation
    ? await (async () => {
        const { data } = await supabase
          .from('gbp_signals')
          .select('user_ratings_total, fetched_at')
          .eq('client_location_id', scanLocation.id)
          .not('user_ratings_total', 'is', null)
          .order('fetched_at', { ascending: false })
          .limit(60)
          .returns<Array<{ user_ratings_total: number; fetched_at: string }>>();
        if (!data || data.length < 2) return null;
        const latest = data[0];
        const oldest = data[data.length - 1];
        const spanDays = Math.round(
          (new Date(latest.fetched_at).getTime() -
            new Date(oldest.fetched_at).getTime()) /
            86_400_000
        );
        if (spanDays < 14) return null;
        const added = Number(latest.user_ratings_total) - Number(oldest.user_ratings_total);
        return {
          latestCount: Number(latest.user_ratings_total),
          added,
          spanDays,
          perMonth: Math.round((added / spanDays) * 30 * 10) / 10,
        };
      })()
    : null;

  // Cross-keyword performance — every tracked keyword for this location with
  // its latest score, so the coach can recommend keyword strategy (kill dead
  // queries, focus winnable ones) instead of being blind to sibling keywords.
  const crossKeyword = scanLocation
    ? await (async () => {
        const { data: kws } = await supabase
          .from('tracked_keywords')
          .select('id, keyword, is_primary')
          .eq('client_id', client.id)
          .eq('location_id', scanLocation.id)
          .returns<Array<{ id: string; keyword: string; is_primary: boolean }>>();
        if (!kws || kws.length <= 1) return null;
        const rows: Array<{
          keyword: string;
          isPrimary: boolean;
          turfScore: number | null;
          turfReach: number | null;
          turfRank: number | null;
        }> = [];
        for (const kw of kws) {
          const { data: latest } = await supabase
            .from('scans')
            .select('turf_score, turf_reach, turf_rank')
            .eq('location_id', scanLocation.id)
            .eq('keyword_id', kw.id)
            .eq('status', 'complete')
            .order('completed_at', { ascending: false })
            .limit(1)
            .maybeSingle<{
              turf_score: number | null;
              turf_reach: number | null;
              turf_rank: number | null;
            }>();
          rows.push({
            keyword: kw.keyword,
            isPrimary: kw.is_primary,
            turfScore: latest?.turf_score != null ? Number(latest.turf_score) : null,
            turfReach: latest?.turf_reach ?? null,
            turfRank: latest?.turf_rank != null ? Number(latest.turf_rank) : null,
          });
        }
        return rows;
      })()
    : null;

  const userPrompt = buildTurfCoachUserPrompt({
    businessName: businessLabel,
    industry: client.industry,
    serviceArea,
    keyword: keyword.keyword,
    turfScore: compositeScore,
    turfReach: reach,
    turfRank: rank,
    momentum: scan.momentum != null ? Number(scan.momentum) : null,
    gridRadiusMiles,
    siblingLocations,
    scoreHistory,
    totalPoints: scan.total_points ?? 81,
    failedPoints: scan.failed_points ?? 0,
    rankGrid,
    competitors: competitorList,
    napAudit,
    gbpSignals,
    reviewVelocity,
    crossKeyword,
  });

  // 3. Call Sonnet with structured output + prompt caching.
  const anthropic = getAnthropic();
  let parsed;
  try {
    const message = await anthropic.messages.parse({
      model: COACH_MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: [
        {
          type: 'text',
          text: TURF_COACH_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userPrompt }],
      output_config: { format: zodOutputFormat(TurfCoachInsight) },
    });
    parsed = message.parsed_output;
  } catch (e) {
    return {
      ok: false,
      error: `AI Coach call failed: ${e instanceof Error ? e.message : String(e)}`,
      status: 502,
    };
  }

  if (!parsed) {
    return {
      ok: false,
      error:
        'AI Coach returned no structured output (model may have refused)',
      status: 502,
    };
  }

  // 4. Persist to ai_insights.
  const { data: inserted, error: insErr } = await supabase
    .from('ai_insights')
    .insert({
      scan_id: scan.id,
      diagnosis: parsed.diagnosis,
      actions: parsed.actions,
      projected_impact: parsed.projectedImpact,
      model: COACH_MODEL,
      prompt_version: TURF_COACH_PROMPT_VERSION,
    })
    .select('*')
    .single();
  if (insErr || !inserted) {
    return {
      ok: false,
      error: `ai_insights insert failed: ${insErr?.message ?? 'no row returned'}`,
      status: 500,
    };
  }

  return {
    ok: true,
    id: inserted.id,
    scanId: scan.id,
    diagnosis: parsed.diagnosis,
    actions: parsed.actions,
    projectedImpact: parsed.projectedImpact,
    model: COACH_MODEL,
    promptVersion: TURF_COACH_PROMPT_VERSION,
  };
}
