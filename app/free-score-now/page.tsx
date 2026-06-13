import type { Metadata } from 'next';
import { QuizFlow } from '@/components/free-score-now/QuizFlow';

/**
 * /free-score-now — quizflow-format paid-traffic lander.
 *
 * Port of the Logik Group quizflow conversion archetype
 * (hard-qualify first → easy multi-choice ladder → contact details
 * last) into TurfMap branding. Lives at a NEW route so we can
 * split-test against the long-scroll /free-score lander via UTM /
 * Vercel routing without losing the existing baseline.
 *
 * Conversion engine reference: /Users/anthonyalfonsi/Claude/quizflow/
 *
 * Wire on completion:
 *   POST /api/score/preview-init  (lead_source='free_score' →
 *     unlock-init auto-applies MAPCHECK50 on /share, same path as
 *     the existing /free-score lander, so the $49 unlock UX is
 *     unchanged for buyers who arrive via the quiz).
 *   trackMetaEvent('Lead', …) on successful submit, eventID +
 *     fbp_cookie + fbc_cookie forwarded for Conversions API
 *     deduplication.
 *
 * Page is paid-traffic only — noindex/nofollow so it doesn't
 * compete with / or /free-score for brand keywords.
 */

export const metadata: Metadata = {
  title: 'Free TurfScore — see exactly where you rank',
  description:
    "60-second visibility audit. We scan 81 Google Maps cells around your service area and show you which ones you're invisible in. Free, no card.",
  robots: { index: false, follow: false },
};

// Force dynamic — the inline QuizFlow uses dvh + the
// GoogleBusinessAutocomplete component, which references `document`
// at module-eval time inside the Mapbox path. Mirrors /score and
// /free-score's pattern.
export const dynamic = 'force-dynamic';

export default function FreeScoreNowPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  return <QuizFlow searchParamsPromise={searchParams} />;
}
