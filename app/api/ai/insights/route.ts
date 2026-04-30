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
import { aggregateCompetitors } from '@/lib/metrics/competitors';
import type {
  ClientRow,
  ScanRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

const RequestBody = z.object({ scanId: z.string().uuid() });

/** Spacing per ring on the default 9×9 / 1.6mi grid. */
const MILES_PER_RING = 0.4;

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

  // 2. Recompute competitors from scan_points (cheap, single query)
  const { data: rawPoints } = await supabase
    .from('scan_points')
    .select('competitors')
    .eq('scan_id', scan.id);
  const points = rawPoints ?? [];

  const ownNamePattern = new RegExp(
    client.business_name.split(/\s+/)[0] ?? '',
    'i'
  );
  const competitors = aggregateCompetitors(points, points.length || 1, {
    excludeNamePattern: ownNamePattern,
  });

  const radiusMiles = (scan.turf_radius_units ?? 0) * MILES_PER_RING;
  const userPrompt = buildTurfCoachUserPrompt({
    businessName: client.business_name,
    industry: client.industry,
    serviceArea: client.address,
    keyword: keyword.keyword,
    turfScore: scan.turf_score,
    top3WinRate: Number(scan.top3_win_rate ?? 0),
    radiusMiles,
    totalPoints: scan.total_points ?? 81,
    failedPoints: scan.failed_points ?? 0,
    competitors,
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
