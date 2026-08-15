/**
 * Out-of-trade competitor filtering.
 *
 * Sibling of geoRegion.ts. That module drops competitors from the wrong
 * CITY; this one drops competitors from the wrong LINE OF BUSINESS.
 *
 * Why this exists: some keywords are trade-ambiguous, and Google's local
 * pack answers a broader question than the client's. Scanning "window
 * replacement" for a residential window contractor returns auto-glass
 * shops — Google is right that they replace windows, just not the kind
 * anyone in this conversation means. Real case: Clear Choice Windows &
 * Doors (Tigard, OR) had "Shield Auto Glass" at 31% grid share and
 * "Evergreen Auto Glass" at 22% sitting in its Competitor Intel card,
 * with the headline urging the client to close a review gap against a
 * windshield shop.
 *
 * That's worse than noise on a client deliverable: it's a comparison
 * that collapses the moment anyone looks at it, and it drags the AI
 * Coach's review-gap math with it (Evergreen's 837 reviews were pulling
 * the field average the client was told to chase).
 *
 * Signal available: the competitor's NAME, and nothing else. DFS's
 * local_pack items carry no category — only title, rating, review count,
 * cid, and a description of tenure/hours/review-snippet. Resolving each
 * competitor's real GBP category would cost a Places call per competitor
 * per scan, on a dashboard render path. So this is name-based, and
 * therefore deliberately narrow.
 *
 * Conservative by design, same contract as geoRegion: a rule fires only
 * when BOTH the client's trade context and the competitor's name are
 * unambiguous. Anything uncertain is kept — wrongly dropping a real
 * competitor is a worse failure than showing an odd one, because the
 * client never learns the dropped rival exists.
 *
 * Pure, no I/O. Guarded by scripts/verify-trade-relevance.ts.
 */

export type TradeContext = {
  /** clients.industry — inconsistent in practice (a mix of Google
   *  place_types like 'general_contractor' and free text like
   *  'windows & doors'), so it is only ever one of two signals. */
  industry?: string | null;
  /** The scanned keyword. Often the sharper signal, since the collision
   *  is what the KEYWORD pulls in, not what the client calls itself. */
  keyword?: string | null;
};

type TradeCollision = {
  id: string;
  /** Client is plausibly in this trade. */
  clientMatches: RegExp;
  /** ...but not when the client is itself on the excluded side of the
   *  collision — an auto-glass client must keep auto-glass rivals. */
  clientExcludes: RegExp;
  /** Competitor names that are unambiguously the OTHER trade. */
  competitorMatches: RegExp;
};

const TRADE_COLLISIONS: readonly TradeCollision[] = [
  {
    // Residential windows/doors/glazing vs automotive glass.
    id: 'residential-glazing-vs-auto-glass',
    clientMatches: /\b(window|windows|door|doors|glass|glazing|sash|fenestration)\b/i,
    clientExcludes: /\b(auto|automotive|windshield|collision|car)\b/i,
    // Every alternative here names a vehicle, not a building. "Glass"
    // alone is deliberately absent: "All Oregon Glass" and "The Glass
    // People" are real residential competitors.
    competitorMatches:
      /\b(auto\s*glass|autoglass|windshield|windscreen|auto\s*body|autobody|collision\s*(center|centre|repair)|car\s*glass|vehicle\s*glass|mobile\s*auto|window\s*tint(ing)?|tint\s*shop)\b/i,
  },
];

/**
 * Should this competitor be dropped as out-of-trade for this client?
 *
 * Returns false whenever the answer isn't clear — no trade context, an
 * unrecognised trade, or a competitor name with no disqualifying marker.
 */
export function isOutOfTrade(
  competitorName: string | null | undefined,
  context: TradeContext | null | undefined
): boolean {
  const name = (competitorName ?? '').trim();
  if (!name || !context) return false;

  // Both signals are searched together: 'windows & doors' may live in
  // industry, or only in the keyword ("window replacement"), or both.
  const clientText = [context.industry, context.keyword]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .join(' ');
  if (!clientText) return false;

  for (const rule of TRADE_COLLISIONS) {
    if (!rule.clientMatches.test(clientText)) continue;
    if (rule.clientExcludes.test(clientText)) continue;
    if (rule.competitorMatches.test(name)) return true;
  }
  return false;
}
