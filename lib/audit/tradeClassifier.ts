/**
 * Shared helpers for the audit purchase + bootstrap surfaces.
 *
 * These three functions were previously inlined in:
 *   - app/api/orders/fulfill/route.ts
 *   - lib/audit/bootstrapCompAudit.ts
 *   - app/api/stripe/webhook/route.ts  (inferTradeFitFromKeyword only)
 *
 * The stripe/webhook variant had already drifted into a flat-array
 * shape that skipped the LLM_TARGET_TRADES safety check. Consolidating
 * here so any future heuristic change applies uniformly across the
 * paid-audit, comp-audit, and Stripe-webhook code paths.
 */
import { LLM_TARGET_TRADES, type LlmTargetTrade } from '@/lib/audit/llmFitScore';

/**
 * First-sentence-ish preview of the AI Roadmap diagnosis blurb for
 * the buyer's roadmap-ready email. The PDF embeds the full diagnosis
 * on the cover page; this is just the teaser the email body quotes
 * so the buyer reads the headline before opening the attachment.
 * Capped at ~220 chars so it doesn't blow out the email layout.
 */
export function previewDiagnosis(diagnosis: string): string {
  const trimmed = diagnosis.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 220) return trimmed;
  // Prefer to cut at a sentence boundary near the cap.
  const sliced = trimmed.slice(0, 220);
  const lastPeriod = sliced.lastIndexOf('. ');
  if (lastPeriod > 80) return `${sliced.slice(0, lastPeriod + 1)}`;
  return `${sliced.trim()}…`;
}

/**
 * Slug a business name into a safe filename component for the Roadmap
 * PDF attachment. Lowercase, hyphens, ASCII-only. Falls back to
 * 'turfmap' on empty input so we always have a valid filename.
 */
export function slugifyBusinessName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'turfmap';
}

/**
 * Map a buyer's primary keyword to one of the LLM target trades.
 * Returns `true` when the keyword unambiguously names one of
 * `LLM_TARGET_TRADES`; `null` when no confident classification is
 * possible. Intentionally never returns `false` — that's reserved for
 * the upstream Fit Score pipeline when it has positive disconfirming
 * signal.
 *
 * The belt-and-suspenders check against LLM_TARGET_TRADES catches the
 * case where the TRADE_KEYWORDS table drifts out of sync with the
 * canonical trade list — better a typecheck error here than a runtime
 * mis-classification.
 */
export function inferTradeFitFromKeyword(
  keyword: string | undefined
): boolean | null {
  if (!keyword) return null;
  const k = keyword.toLowerCase();
  const TRADE_KEYWORDS: Array<{ trade: LlmTargetTrade; needles: string[] }> = [
    { trade: 'electrical', needles: ['electrician', 'electrical'] },
    {
      trade: 'hvac',
      needles: ['hvac', 'heating', 'air conditioning', 'a/c repair', 'furnace'],
    },
    {
      trade: 'landscaping',
      needles: ['landscap', 'lawn care', 'lawn maintenance'],
    },
    { trade: 'plumbing', needles: ['plumb', 'drain cleaning', 'water heater'] },
    {
      trade: 'renovation',
      needles: ['renovat', 'remodel', 'kitchen remodel', 'bathroom remodel'],
    },
    {
      trade: 'restoration',
      needles: ['restoration', 'water damage', 'fire damage', 'mold remediation'],
    },
    { trade: 'roofing', needles: ['roof'] },
    {
      trade: 'windows_doors',
      needles: ['windows', 'doors', 'window install', 'door install'],
    },
  ];
  for (const { trade, needles } of TRADE_KEYWORDS) {
    for (const needle of needles) {
      if (k.includes(needle)) {
        if ((LLM_TARGET_TRADES as readonly string[]).includes(trade)) {
          return true;
        }
      }
    }
  }
  return null;
}
