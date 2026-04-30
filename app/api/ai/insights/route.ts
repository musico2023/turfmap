/**
 * POST /api/ai/insights
 *
 * Generates a TurfMap AI Coach playbook for a scan, persists it to
 * ai_insights, and returns the structured insight.
 *
 * Body:    { scanId: string }
 * Returns: { id, scan_id, diagnosis, actions, projected_impact, model, prompt_version }
 *
 * Uses Anthropic Sonnet 4.6 with adaptive thinking, structured Zod output,
 * and prompt caching on the (long, stable) system prompt.
 *
 * Cost target: <$0.05 per call.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { COACH_MODEL, getAnthropic } from '@/lib/anthropic/client';
import {
  TURF_COACH_PROMPT_VERSION,
  TURF_COACH_SYSTEM_PROMPT,
  TurfCoachInsight,
  buildTurfCoachUserPrompt,
} from '@/lib/anthropic/prompts/turfCoach';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { packStrength } from '@/lib/metrics/packStrength';
import type {
  ClientRow,
  ScanRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

const RequestBody = z.object({ scanId: z.string().uuid() });

/** 9×9 grid is 4 rings out from center, so spacing = service_radius / 4. */
const RINGS_FROM_CENTER = 4;

export async function POST(req: Request) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  let body: { scanId: string };
  try {
    body = RequestBody.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  // 1. Load the scan, client, keyword
  const { data: scan } = await supabase
    .from('scans')
    .select('*')
    .eq('id', body.scanId)
    .maybeSingle<ScanRow>();
  if (!scan) {
    return NextResponse.json({ error: 'scan not found' }, { status: 404 });
  }
  if (scan.status !== 'complete') {
    return NextResponse.json(
      { error: `scan status is "${scan.status}" — only complete scans can be analyzed` },
      { status: 409 }
    );
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
    return NextResponse.json(
      { error: 'client or keyword missing for this scan' },
      { status: 500 }
    );
  }

  // 2. Pull scan_points + build the 9×9 client rank grid + observed
  //    competitor leaderboard (top 10 by appearance count). The grid lets
  //    Claude see the actual geographic pattern; the explicit list keeps
  //    it from confabulating brand names from training data.
  const { data: rawPoints } = await supabase
    .from('scan_points')
    .select('grid_x, grid_y, rank, competitors')
    .eq('scan_id', scan.id);
  const points = rawPoints ?? [];

  // 9×9 client rank grid (y=row, x=col)
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

  // Top competitors by appearance count, excluding the client's own brand.
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
    for (const c of list) {
      if (!c?.name) continue;
      if (ownNamePattern.test(c.name)) continue;
      const rank = c.rank_group ?? c.rank_absolute ?? null;
      if (rank === null || rank > 3) continue;
      const s = compStats.get(c.name) ?? { ranks: [] };
      s.ranks.push(rank);
      compStats.set(c.name, s);
    }
  }
  const competitorList = [...compStats.entries()]
    .map(([name, s]) => ({
      name,
      appearances: s.ranks.length,
      avgRank: s.ranks.reduce((a, b) => a + b, 0) / s.ranks.length,
      bestRank: Math.min(...s.ranks),
    }))
    .sort((a, b) => b.appearances - a.appearances || a.avgRank - b.avgRank)
    .slice(0, 10);

  const milesPerRing = (client.service_radius_miles ?? 1.6) / RINGS_FROM_CENTER;
  const radiusMiles = (scan.turf_radius_units ?? 0) * milesPerRing;
  // Compute Pack Strength inline from scan_points — it's a derived metric
  // and not stored in the scans table.
  const ranksFromPoints = points.map(
    (p) => (p.rank as number | null) ?? null
  );
  const strength = packStrength(ranksFromPoints);
  const userPrompt = buildTurfCoachUserPrompt({
    businessName: client.business_name,
    industry: client.industry,
    serviceArea: client.address,
    keyword: keyword.keyword,
    turfScore: scan.turf_score,
    packStrength: strength,
    top3WinRate: Number(scan.top3_win_rate ?? 0),
    radiusMiles,
    gridRadiusMiles: client.service_radius_miles ?? 1.6,
    totalPoints: scan.total_points ?? 81,
    failedPoints: scan.failed_points ?? 0,
    rankGrid,
    competitors: competitorList,
  });

  // 3. Call Sonnet 4.6 with structured output + prompt caching
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
    return NextResponse.json(
      {
        error: `AI Coach call failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 502 }
    );
  }

  if (!parsed) {
    return NextResponse.json(
      { error: 'AI Coach returned no structured output (model may have refused)' },
      { status: 502 }
    );
  }

  // 4. Persist to ai_insights
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
  if (insErr) {
    return NextResponse.json(
      { error: `ai_insights insert failed: ${insErr.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    id: inserted.id,
    scanId: scan.id,
    diagnosis: parsed.diagnosis,
    actions: parsed.actions,
    projectedImpact: parsed.projectedImpact,
    model: COACH_MODEL,
    promptVersion: TURF_COACH_PROMPT_VERSION,
  });
}
