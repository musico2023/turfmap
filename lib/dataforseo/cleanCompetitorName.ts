/**
 * Sanitize competitor business names returned by DataForSEO's Local
 * Pack endpoint.
 *
 * DFS's HTML parser occasionally concatenates Google UI elements
 * into the visible business name when those elements are inline with
 * the result row. The most common case is Google's "My Ad Center"
 * indicator — the small (i) badge linking to myadcenter.google.com
 * that appears next to Local Pack entries to explain why a result
 * was shown. Real-world example we caught in prod:
 *
 *   name: "bloomer's Queen        My Ad Center"
 *
 * The actual business is "bloomer's Queen" — the trailing label is
 * scraped Google chrome that leaked through.
 *
 * Called on BOTH sides of the persistence boundary:
 *   - write time: lib/scans/runScan.ts when we materialize
 *     scan_points.competitors from DFS results, so future rows
 *     store clean names.
 *   - read time: lib/metrics/competitors.ts (the aggregator) so
 *     scan_points rows already stored with dirty names render
 *     cleanly in Slack alerts, emails, and the dashboard.
 *
 * Pure function, no side effects, safe to call repeatedly on
 * already-clean strings.
 */

/** Patterns we strip when they appear at the end of a name, after
 *  whitespace. Order matters — more specific patterns first.
 *  Trailing `\s*$` is implied; whitespace before each pattern is
 *  matched separately so we can also clean any preceding
 *  whitespace block. */
const TRAILING_GOOGLE_UI_LABELS: readonly RegExp[] = [
  // The original observed case + close variants.
  /\s+My\s+Ad\s+Center\s*$/i,
  // Sponsored / paid-result indicator that occasionally leaks.
  /\s+Sponsored\s*$/i,
  // "About this result" — another contextual Google UI element.
  /\s+About\s+this\s+result\s*$/i,
];

export function cleanCompetitorName(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  let cleaned = raw;

  // Strip known trailing Google UI labels. Loop until none remain —
  // defensive against double-stamping (e.g. "Foo My Ad Center
  // Sponsored").
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of TRAILING_GOOGLE_UI_LABELS) {
      const stripped = cleaned.replace(re, '');
      if (stripped !== cleaned) {
        cleaned = stripped;
        changed = true;
      }
    }
  }

  // Collapse internal whitespace runs to a single space. DFS sometimes
  // returns tabs / multi-space gaps between visible-name tokens that
  // we don't want preserved in display surfaces.
  cleaned = cleaned.replace(/\s+/g, ' ');

  return cleaned.trim();
}
