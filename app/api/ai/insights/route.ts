/**
 * POST /api/ai/insights
 *
 * Operator-triggered AI Coach playbook generation. Agency staff click the
 * AICoachGenerateButton on a completed scan in the agency console; that
 * button POSTs here.
 *
 * Body:    { scanId: string }
 * Returns: { id, scanId, diagnosis, actions, projectedImpact, model, promptVersion }
 *
 * The heavy lifting (prompt build, NAP audit wait, Claude call, persist)
 * lives in lib/ai-coach/generateInsight so the same orchestration can
 * also run from contexts without an agency session — notably the COLDSCAN
 * fulfill route, which pre-generates the Fix List for cold-cohort buyers
 * who never see an agency-side Generate button (public /share/[id] only).
 *
 * Cost target: <$0.05 per call. NAP audit wait budget is the route's
 * full ~240s (300s maxDuration minus ~50s headroom for Claude).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { generateInsight } from '@/lib/ai-coach/generateInsight';

export const runtime = 'nodejs';
export const maxDuration = 300;

const RequestBody = z.object({ scanId: z.string().uuid() });

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
  const result = await generateInsight(supabase, body.scanId, auth.id);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    id: result.id,
    scanId: result.scanId,
    diagnosis: result.diagnosis,
    actions: result.actions,
    projectedImpact: result.projectedImpact,
    model: result.model,
    promptVersion: result.promptVersion,
  });
}
