/**
 * POST /api/ai/insights
 *
 * Operator-triggered AI Coach playbook generation. Agency staff click the
 * AICoachGenerateButton on a completed scan in the agency console; that
 * button POSTs here.
 *
 * Body:    { scanId: string, regenerate?: boolean }
 * Returns: { id, scanId, diagnosis, actions, projectedImpact, model, promptVersion }
 *
 * The heavy lifting (prompt build, NAP audit wait, Claude call, persist)
 * lives in lib/ai-coach/generateInsight so the same orchestration can
 * also run from contexts without an agency session — notably the COLDSCAN
 * fulfill route, which pre-generates the Fix List for cold-cohort buyers
 * who never see an agency-side Generate button (public /share/[id] only).
 *
 * `regenerate: true` deletes any prior ai_insights rows for the scan
 * before generating a fresh one. Use this after editing client locations
 * or NAP data — the cached insight reflects the data at original
 * generation time and doesn't auto-refresh. Regenerate is gated to
 * authenticated agency staff (this route's auth wrapper) — public
 * /share/[id] callers don't get to retrigger paid Claude calls.
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

const RequestBody = z.object({
  scanId: z.string().uuid(),
  regenerate: z.boolean().optional(),
});

export async function POST(req: Request) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;

  let body: z.infer<typeof RequestBody>;
  try {
    body = RequestBody.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 }
    );
  }

  const supabase = getServerSupabase();

  // Regenerate path: blow away the prior insight(s) for this scan so
  // generateInsight() — which always inserts — leaves exactly one
  // canonical row. Readers dedupe by `ORDER BY created_at DESC LIMIT 1`,
  // but accumulating stale rows wastes storage and confuses any future
  // history view. Delete is scoped to scan_id only; the FK from
  // ai_insights → scans is ON DELETE CASCADE, but that doesn't fire on
  // an UPDATE / re-generate path.
  if (body.regenerate) {
    const { error: delErr } = await supabase
      .from('ai_insights')
      .delete()
      .eq('scan_id', body.scanId);
    if (delErr) {
      return NextResponse.json(
        { error: `regenerate: failed to clear prior insight (${delErr.message})` },
        { status: 500 }
      );
    }
  }

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
