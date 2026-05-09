/**
 * Strategist Prep Notes generator — produces the 1-2 page markdown
 * document that lands in anthony@fourdots.io's inbox 24 hours before
 * each Visibility Audit strategist call.
 *
 * Distinct from the Roadmap PDF generator (which makes a polished
 * deliverable for the buyer). Prep notes are operator-facing, plain
 * markdown, optimized for skimming on the Cal.com call page or in
 * Superhuman.
 *
 * Inputs include the LLM Fit Score breakdown — the score itself is
 * computed deterministically by lib/audit/llmFitScore.ts; this
 * generator only wraps prose around it. Importantly, the prep notes
 * select 1-2 problem-mapped LLM segues based on the buyer's signal
 * profile and pre-write the strategist's lines verbatim.
 *
 * Cost target: <$0.10 per call (Sonnet 4.6, ~3k tokens, no thinking
 * budget — this is a structured-prose task).
 */

import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { COACH_MODEL, getAnthropic } from '@/lib/anthropic/client';
import { llmFitLabel, shouldPitchLlm } from '@/lib/audit/llmFitScore';
import type { LlmFitBreakdown } from '@/lib/supabase/types';

export const STRATEGIST_PREP_VERSION = 'strategist_prep_v1';

// ─── Problem-mapped LLM segues (spec verbatim) ────────────────────────
//
// The signal-to-segue mapping comes from the spec. Encoded here as
// data so the AI prompt can reference + select the highest-confidence
// segues for each buyer. The model returns an ordered list of segue
// IDs it selected; we map those back to the canonical text below.

export type SegueId =
  | 'review_velocity_bottleneck'
  | 'paid_ads_already_running'
  | 'revenue_no_visibility'
  | 'high_ltv_trade'
  | 'no_segue_not_fit';

export type Segue = {
  id: SegueId;
  /** Trigger condition the AI evaluates. */
  signal: string;
  /** What the buyer is likely struggling with. Surfaces in the
   *  "LIKELY PROBLEM" line of the prep notes. */
  likelyProblem: string;
  /** Pre-written verbatim line for Anthony to use on the call. */
  segue: string;
};

export const PROBLEM_MAPPED_SEGUES: Segue[] = [
  {
    id: 'review_velocity_bottleneck',
    signal: '<50 reviews AND 50+ NAP issues',
    likelyProblem: 'Review velocity is broken',
    segue:
      "After your Roadmap, you'll have 3-4x more inbound. The bottleneck won't be visibility — it'll be capturing leads fast enough. LLM's automated SMS+email post-job system handles that part.",
  },
  {
    id: 'paid_ads_already_running',
    signal: 'Apify-confirmed Google or Meta ads currently active',
    likelyProblem: 'Running paid ads, possibly poorly',
    segue:
      "I noticed you're already running paid ads. Most operators at your scale are getting 30-40% wasted spend on misaligned targeting. We'd audit your existing campaigns at no charge if you proceed with LLM.",
  },
  {
    id: 'revenue_no_visibility',
    signal: '100+ reviews AND TurfScore <40',
    likelyProblem: 'Has revenue, lacks visibility',
    segue:
      "Your reviews show real revenue. Your visibility shows you're invisible to most of your service area. LLM's full implementation is built for operators in exactly this position.",
  },
  {
    id: 'high_ltv_trade',
    signal: 'HVAC or Roofing trade AND major metro',
    likelyProblem: 'High-LTV opportunity',
    segue:
      "HVAC operators at your scale typically see $80-150K/mo within 12 months of full LLM implementation. We can talk about what that looks like for your specific market.",
  },
  {
    id: 'no_segue_not_fit',
    signal:
      'Outside trade scope OR <$50K/mo signal OR small market',
    likelyProblem: 'Not LLM fit',
    segue: '',
  },
];

const SEGUE_BY_ID: Readonly<Record<SegueId, Segue>> = Object.freeze(
  PROBLEM_MAPPED_SEGUES.reduce(
    (acc, s) => {
      acc[s.id] = s;
      return acc;
    },
    {} as Record<SegueId, Segue>
  )
);

// ─── Structured output schema ─────────────────────────────────────────

const PrepOutput = z.object({
  /** 3-5 bullets — the most important things Anthony should know
   *  before the call. */
  keyFindings: z
    .array(z.string().min(15))
    .min(3)
    .max(5)
    .describe(
      "3-5 bullets surfacing the most consequential findings. Lead with the single highest-impact fix; include any unusual or surprising findings; flag data-quality concerns last."
    ),
  /** Competitive context — top competitor + how they differ. */
  competitiveContext: z
    .string()
    .min(40)
    .describe(
      "2-4 sentences naming the top competitor (if present in input), their TurfScore, and what they're doing differently. If no competitor data is provided, write 'No competitor data available — surface this on the call as a follow-up.'"
    ),
  /** IDs of the 1-2 segues that best match this buyer's signals.
   *  The prompt enumerates them; the model picks the highest-
   *  confidence matches. */
  selectedSegueIds: z
    .array(
      z.enum([
        'review_velocity_bottleneck',
        'paid_ads_already_running',
        'revenue_no_visibility',
        'high_ltv_trade',
        'no_segue_not_fit',
      ])
    )
    .min(1)
    .max(2)
    .describe(
      "1-2 segue IDs from the canonical list that best fit this buyer's signals. For LLM Fit Score 1, select 'no_segue_not_fit' only."
    ),
  /** 5-7 talking points the strategist can read in order on the
   *  call. Includes diagnosis, fastest-win, the selected segues
   *  rendered inline, and 2-3 anticipated objections. Length depends
   *  on Fit Score (4-5 = full segues; 1-3 = short, no LLM segue). */
  talkingPoints: z
    .array(z.string().min(15))
    .min(5)
    .max(8)
    .describe(
      "5-7 ordered talking points (up to 8 if needed). Open with diagnosis, follow with fastest-win, then segues for Fit Score 4-5 (or skip + redirect for Fit Score 2-3). End with 2-3 anticipated buyer objections + responses. Each point can run long when it incorporates the verbatim segue or an objection-and-response pair."
    ),
});

export type PrepOutputT = z.infer<typeof PrepOutput>;

// ─── Prompt construction ──────────────────────────────────────────────

function buildSystemPrompt(): string {
  const segueList = PROBLEM_MAPPED_SEGUES.map(
    (s) =>
      `- ${s.id}: SIGNAL="${s.signal}" | LIKELY="${s.likelyProblem}"`
  ).join('\n');

  return `You generate Strategist Prep Notes for the founder of Fourdots Digital (Anthony) ahead of a Visibility Audit strategist call. The buyer has paid $499 (or $197 upgrade) for the audit; you've never met them. Your output is a 1-2 page markdown document that helps Anthony walk into the call already knowing what to say.

THE OUTPUT IS FOR ANTHONY ONLY. The buyer never sees it. Skip pleasantries, skip framing — go straight to substance.

YOUR JOB:
1. Surface the 3-5 most consequential findings.
2. Name the top competitor and one specific differential.
3. Pick 1-2 problem-mapped LLM segues from the canonical list.
4. Write 5-7 talking points in delivery order, with the selected segues' verbatim text rendered inline.

LLM FIT SCORE GATING (critical):
- Fit Score 4-5 (Strong/Likely fit): full segues, pricing context ($5,997 setup + $2,500/mo, 4 spots/month, one per trade per metro), 2-3 anticipated objections + responses.
- Fit Score 2-3 (Possible/Weak fit): diagnosis + fastest-win only. Do NOT pitch LLM. If they bring it up, redirect: "Let's get your TurfScore into the 60+ band first, then talk about scaling."
- Fit Score 1 (Not fit): diagnosis only. Do NOT mention Local Lead Machine.

CANONICAL SEGUE LIST (you select by ID; the system renders the verbatim text):

${segueList}

FOR FIT SCORE 1: select 'no_segue_not_fit' only. The verbatim text is empty — that's intentional.
FOR FIT SCORE 2-3: select the most relevant segue but the talking-point copy should explicitly NOT pitch LLM. Use the segue ID for downstream tooling tracking, but write talking points that suppress the pitch.
FOR FIT SCORE 4-5: select 1-2 high-confidence segues; talking points render the verbatim segue text inline.

WRITE FOR THE STRATEGIST. Markdown is fine but skip headings — your structured output will be wrapped in a generated template downstream. Be terse, specific, and grounded in the buyer's actual data.`;
}

export type PrepInput = {
  /** Buyer business name, trade, market, scheduled call time. */
  businessName: string;
  trade: string;
  market: string;
  scheduledCallTime: string;
  /** Score family for context. */
  currentTurfScore: number;
  projectedTurfScore: number;
  /** Computed deterministically upstream — pass in for the prompt. */
  llmFitScore: number;
  llmFitBreakdown: LlmFitBreakdown;
  /** Same compact summaries as the roadmap generator uses. */
  napFindingsSummary: string | null;
  competitorSummary: string | null;
  cellPatternSummary: string | null;
  /** Roadmap diagnosis (already generated upstream — passed in so
   *  the prep notes can reference it without re-deriving). */
  roadmapDiagnosis: string;
};

function buildUserPrompt(input: PrepInput): string {
  const parts: string[] = [
    `BUYER: ${input.businessName} — ${input.trade} in ${input.market}`,
    `SCHEDULED CALL TIME: ${input.scheduledCallTime}`,
    '',
    `CURRENT TURFSCORE: ${input.currentTurfScore} | PROJECTED 30-DAY: ${input.projectedTurfScore}`,
    '',
    `LLM FIT SCORE: ${input.llmFitScore}/5 (${llmFitLabel(input.llmFitScore)})`,
    `Pitch LLM on call: ${shouldPitchLlm(input.llmFitScore) ? 'YES' : 'NO'}`,
    `Fit breakdown:`,
    `  - Revenue band: ${input.llmFitBreakdown.inputs.revenue_band ?? 'unknown'}`,
    `  - Trade fit: ${input.llmFitBreakdown.inputs.trade_fit ?? 'unknown'}`,
    `  - Metro fit: ${input.llmFitBreakdown.inputs.metro_fit ?? 'unknown'}`,
    `  - Currently running paid ads: ${input.llmFitBreakdown.inputs.ad_active ?? 'unknown'}`,
    `  - Review count: ${input.llmFitBreakdown.inputs.review_count ?? 'unknown'}`,
    `  - Rules fired: ${input.llmFitBreakdown.rule_hits.join(', ')}`,
    '',
    `ROADMAP DIAGNOSIS (use as anchor for the call's opening):`,
    input.roadmapDiagnosis,
    '',
    'AUDIT DATA:',
  ];

  if (input.cellPatternSummary) {
    parts.push(`- Cell pattern: ${input.cellPatternSummary}`);
  }
  if (input.napFindingsSummary) {
    parts.push('', 'NAP FINDINGS:', input.napFindingsSummary);
  }
  if (input.competitorSummary) {
    parts.push('', 'TOP COMPETITORS:', input.competitorSummary);
  }

  parts.push(
    '',
    'Generate the prep notes as structured JSON. Pick segues that match this buyer\'s signals; honor the Fit Score gating rules.'
  );

  return parts.join('\n');
}

// ─── Caller + markdown rendering ──────────────────────────────────────

export type GeneratedPrepNotes = {
  /** Structured fields — useful for downstream tooling (e.g., the
   *  Slack notification could surface keyFindings[0]). */
  keyFindings: string[];
  competitiveContext: string;
  selectedSegues: Segue[];
  talkingPoints: string[];
  /** Final rendered markdown — what gets emailed to Anthony. */
  markdown: string;
  /** Stable version tag for traceability. */
  version: string;
};

export async function generateStrategistPrep(
  input: PrepInput
): Promise<GeneratedPrepNotes> {
  const anthropic = getAnthropic();
  const message = await anthropic.messages.parse({
    model: COACH_MODEL,
    max_tokens: 4000,
    system: [
      {
        type: 'text',
        text: buildSystemPrompt(),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: buildUserPrompt(input) }],
    output_config: { format: zodOutputFormat(PrepOutput) },
  });

  const parsed = message.parsed_output;
  if (!parsed) {
    throw new Error(
      'Strategist prep generator returned no structured output'
    );
  }

  const selectedSegues = parsed.selectedSegueIds.map(
    (id) => SEGUE_BY_ID[id]
  );

  const markdown = renderPrepMarkdown({
    input,
    output: parsed,
    selectedSegues,
  });

  return {
    keyFindings: parsed.keyFindings,
    competitiveContext: parsed.competitiveContext,
    selectedSegues,
    talkingPoints: parsed.talkingPoints,
    markdown,
    version: STRATEGIST_PREP_VERSION,
  };
}

/**
 * Render the structured output as markdown. Done in code, not the
 * prompt, so the document layout stays consistent across calls and
 * we can refactor the format without re-prompting.
 */
function renderPrepMarkdown(args: {
  input: PrepInput;
  output: PrepOutputT;
  selectedSegues: Segue[];
}): string {
  const { input, output, selectedSegues } = args;
  const fitLabel = llmFitLabel(input.llmFitScore);
  const pitchFlag = shouldPitchLlm(input.llmFitScore) ? 'YES' : 'NO';

  const lines: string[] = [
    `# ${input.businessName} — Strategist Prep`,
    '',
    `**${input.trade} in ${input.market}** | Call scheduled: ${input.scheduledCallTime}`,
    '',
    `**TurfScore:** ${input.currentTurfScore} (current) → ${input.projectedTurfScore} (30-day target)`,
    '',
    `**LLM Fit Score:** ${input.llmFitScore}/5 — ${fitLabel}`,
    `**Pitch LLM on call:** ${pitchFlag}`,
    '',
    '---',
    '',
    '## Key findings',
    '',
    ...output.keyFindings.map((f) => `- ${f}`),
    '',
    '## Competitive context',
    '',
    output.competitiveContext,
    '',
    '## LLM segue (use verbatim if pitching)',
    '',
  ];

  if (selectedSegues.length === 0) {
    lines.push('_No segue applies — buyer is not LLM-fit. Diagnosis-only call._');
  } else {
    for (const s of selectedSegues) {
      lines.push(`**Likely problem:** ${s.likelyProblem}`);
      lines.push('');
      if (s.segue) {
        lines.push('**Verbatim segue line:**');
        lines.push('');
        lines.push(`> ${s.segue}`);
      } else {
        lines.push('_No verbatim segue (Fit Score 1, do not pitch LLM)._');
      }
      lines.push('');
    }
  }

  lines.push('## Talking points (in delivery order)', '');
  output.talkingPoints.forEach((p, i) => {
    lines.push(`${i + 1}. ${p}`);
  });

  lines.push(
    '',
    '---',
    '',
    `_Generated by ${STRATEGIST_PREP_VERSION}. LLM Fit Score rule hits: ${input.llmFitBreakdown.rule_hits.join(', ')}._`
  );

  return lines.join('\n');
}
