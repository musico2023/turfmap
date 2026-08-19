/**
 * Per-share-link momentum scrubbing for AI Coach prose.
 *
 * Hiding the MomentumCard isn't enough to honour hide_momentum: the Coach's
 * stored copy quotes the number inline ("sustaining the +24 Momentum
 * requires…", "With Momentum at +24 resting on only two scan-day data
 * points (17 → 41)…"). Those strings live in ai_insights, which is keyed by
 * scan_id and read by the dashboard, portal and PDF too — so we cannot edit
 * the row to fix one share page. We scrub at render, per link.
 *
 * Conservative by design: drop whole clauses, never rewrite them. A clause
 * that mentions momentum goes; everything else is preserved verbatim. If
 * scrubbing would leave a fragment too short to read as a sentence, the
 * whole field is dropped instead of shipping a mangled one.
 *
 * Pure, no I/O. Guarded by scripts/verify-strip-momentum.ts.
 */

/** Momentum mentions, plus the "17 → 41" style deltas that only exist to
 *  narrate one. Arrow forms: →, ->, and the en/em dash pairs the model uses. */
const MOMENTUM_RE = /momentum/i;
const SCORE_DELTA_RE = /\(\s*\d{1,3}\s*(?:→|->|–>|—>)\s*\d{1,3}\s*\)/;

/** Anything shorter than this after scrubbing is a fragment, not a sentence. */
const MIN_KEEP_CHARS = 25;

function mentionsMomentum(s: string): boolean {
  return MOMENTUM_RE.test(s) || SCORE_DELTA_RE.test(s);
}

/** A clause plus the separator that preceded it in the source ('' for the
 *  first). Keeping the original separator matters: ", and " is ambiguous —
 *  it joins clauses AND terminates an Oxford list ("content, expansion, and
 *  velocity"). Rejoining survivors with a fixed separator turns the list
 *  case into "expansion; velocity". Reusing each kept clause's own
 *  separator reassembles both cases correctly. */
type Clause = { text: string; sep: string };

function splitClauses(sentence: string): Clause[] {
  // Capturing split → [clause, sep, clause, sep, …].
  const parts = sentence.split(/(;\s+|,\s+and\s+)/g);
  const out: Clause[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i];
    if (!text || !text.trim()) continue;
    out.push({ text, sep: i === 0 ? '' : (parts[i - 1] ?? '; ') });
  }
  return out;
}

/** Rejoin survivors using each clause's original separator. The first kept
 *  clause never carries one, whatever it was preceded by. */
function joinClauses(clauses: Clause[]): string {
  return clauses
    .map((c, i) => (i === 0 ? c.text.trim() : `${c.sep}${c.text.trim()}`))
    .join('');
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/g).filter((s) => s.trim().length > 0);
}

function tidy(s: string): string {
  let out = s.trim();
  // A kept clause that used to sit mid-sentence won't be terminated.
  if (!/[.!?]$/.test(out)) out += '.';
  // Leading lowercase reads wrong once the clause before it is gone.
  out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

/**
 * Remove momentum-bearing clauses from a block of Coach prose.
 * Returns null when nothing publishable survives.
 */
export function stripMomentumText(text: string | null | undefined): string | null {
  if (!text || !text.trim()) return null;
  if (!mentionsMomentum(text)) return text;

  const keptSentences: string[] = [];
  for (const sentence of splitSentences(text)) {
    if (!mentionsMomentum(sentence)) {
      keptSentences.push(sentence.trim());
      continue;
    }
    const keptClauses = splitClauses(sentence).filter(
      (c) => !mentionsMomentum(c.text)
    );
    if (keptClauses.length === 0) continue;
    const rebuilt = tidy(joinClauses(keptClauses));
    if (rebuilt.replace(/[^a-z0-9]/gi, '').length >= MIN_KEEP_CHARS) {
      keptSentences.push(rebuilt);
    }
  }

  const out = keptSentences.join(' ').trim();
  if (out.replace(/[^a-z0-9]/gi, '').length < MIN_KEEP_CHARS) return null;
  return out;
}

/** Scrub an action's `why`. Drops the action entirely (returns null) when
 *  its rationale doesn't survive — an action with no reason is noise. */
export function stripMomentumAction<T extends { why?: string | null }>(
  action: T
): T | null {
  const why = stripMomentumText(action.why);
  if (!why) return null;
  return { ...action, why };
}
