/**
 * visibility_audits CRUD helpers.
 *
 * Phase 1: insert + read. Phase 2 will add update helpers for
 * roadmap_pdf_url / prep_notes_url; Phase 3 for the call-completion +
 * 60-day-prompt transitions.
 *
 * All write paths use the service-role Supabase client (bypasses RLS).
 * The agency-read policy lets operators inspect rows from the
 * dashboard via the cookie-bound client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ActionCategory,
  ActionPriority,
  DifficultyRating,
  LlmFitBreakdown,
  RoadmapActionRow,
  VisibilityAuditRow,
} from '@/lib/supabase/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = SupabaseClient<any, any, any>;

export type CreateVisibilityAuditInput = {
  leadOrderId: string;
  scanId: string;
  clientId: string;
  /** Optional — null until the AI Roadmap Generator runs. */
  startingTurfScore?: number | null;
  liftPromiseTargetScore?: number | null;
  /** Optional — null until the LLM Fit Score is computed. */
  llmFitScore?: number | null;
  llmFitBreakdown?: LlmFitBreakdown | null;
};

/**
 * Idempotent INSERT — on conflict by lead_order_id, returns the
 * existing row. Phase 1 callers (the fulfill route) use this to
 * stamp a row at audit fulfillment without worrying about duplicate
 * inserts on retry.
 */
export async function createVisibilityAudit(
  supabase: SupabaseLike,
  input: CreateVisibilityAuditInput
): Promise<{ ok: true; row: VisibilityAuditRow } | { ok: false; error: string }> {
  // Probe first — same pattern ensureLeadOrder uses. Avoids a noisy
  // PG error log on the conflict path.
  const { data: existing } = await supabase
    .from('visibility_audits')
    .select('*')
    .eq('lead_order_id', input.leadOrderId)
    .maybeSingle<VisibilityAuditRow>();
  if (existing) {
    return { ok: true, row: existing };
  }

  const { data, error } = await supabase
    .from('visibility_audits')
    .insert({
      lead_order_id: input.leadOrderId,
      scan_id: input.scanId,
      client_id: input.clientId,
      status: 'pending_call_schedule',
      starting_turfscore: input.startingTurfScore ?? null,
      lift_promise_target_score: input.liftPromiseTargetScore ?? null,
      llm_fit_score: input.llmFitScore ?? null,
      llm_fit_breakdown: input.llmFitBreakdown ?? null,
    })
    .select('*')
    .single<VisibilityAuditRow>();

  if (error || !data) {
    return {
      ok: false,
      error: error?.message ?? 'no row returned from visibility_audits insert',
    };
  }
  return { ok: true, row: data };
}

/** Patch arbitrary fields on a visibility_audits row. Used by the
 *  Phase 2 + 3 pipelines to stamp PDF URLs, call-completion
 *  timestamps, etc. The updated_at column is maintained by a DB
 *  trigger so we don't pass it from app code. */
export async function patchVisibilityAudit(
  supabase: SupabaseLike,
  auditId: string,
  patch: Partial<
    Omit<VisibilityAuditRow, 'id' | 'lead_order_id' | 'created_at' | 'updated_at'>
  >
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from('visibility_audits')
    .update(patch)
    .eq('id', auditId);
  if (error) {
    console.error('[visibility_audits] patch failed', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export type RoadmapActionInsert = {
  weekNumber: number;
  actionText: string;
  actionCategory: ActionCategory;
  projectedScoreLift: number;
  difficultyRating: DifficultyRating;
  priority: ActionPriority;
  llmCovered: boolean;
};

/**
 * Bulk-insert roadmap_actions for a freshly-generated audit.
 * Returns the inserted rows so the caller can confirm the count
 * matched the AI's output. Idempotency is the caller's responsibility
 * — we DON'T upsert here because re-generating a roadmap should
 * produce a NEW audit row, not overwrite an existing roadmap.
 */
export async function insertRoadmapActions(
  supabase: SupabaseLike,
  auditId: string,
  actions: RoadmapActionInsert[]
): Promise<{ ok: boolean; inserted: number; error?: string }> {
  if (actions.length === 0) {
    return { ok: true, inserted: 0 };
  }
  const rows = actions.map((a) => ({
    audit_id: auditId,
    week_number: a.weekNumber,
    action_text: a.actionText,
    action_category: a.actionCategory,
    projected_score_lift: a.projectedScoreLift,
    difficulty_rating: a.difficultyRating,
    priority: a.priority,
    llm_covered: a.llmCovered,
  }));

  const { data, error } = await supabase
    .from('roadmap_actions')
    .insert(rows)
    .select('id');

  if (error) {
    console.error('[roadmap_actions] bulk insert failed', error);
    return { ok: false, inserted: 0, error: error.message };
  }
  return { ok: true, inserted: data?.length ?? 0 };
}

/** Read an audit + its roadmap actions. Phase 2/3 PDF + dashboard
 *  pipelines use this. Returns null if the audit doesn't exist. */
export async function getVisibilityAuditWithActions(
  supabase: SupabaseLike,
  auditId: string
): Promise<{
  audit: VisibilityAuditRow;
  actions: RoadmapActionRow[];
} | null> {
  const { data: audit } = await supabase
    .from('visibility_audits')
    .select('*')
    .eq('id', auditId)
    .maybeSingle<VisibilityAuditRow>();
  if (!audit) return null;

  const { data: actions } = await supabase
    .from('roadmap_actions')
    .select('*')
    .eq('audit_id', auditId)
    .order('week_number', { ascending: true });

  return {
    audit,
    actions: (actions ?? []) as RoadmapActionRow[],
  };
}
