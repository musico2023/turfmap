/**
 * GET /api/dev/audit-fixture
 *
 * Dev-only fixture endpoint that runs the Phase 1 Visibility Audit
 * pipeline (LLM Fit Score → AI Roadmap Generator → Strategist Prep
 * Notes) against a hard-coded buyer profile and returns the full
 * outputs as JSON for inspection.
 *
 * No production side effects: doesn't insert any rows, doesn't send
 * any emails, doesn't touch Stripe or Cal.com. Just exercises the
 * generators end-to-end so we can sanity-check the structured
 * outputs before wiring them into the real fulfill route.
 *
 * Gated to fourdots-domain agency emails — internal-only tool.
 *
 * Query params:
 *   profile=high     →  HVAC, major metro, 200 reviews, ad-active (Fit 5)
 *   profile=low      →  Landscaping, small market, 25 reviews     (Fit 1)
 *   profile=medium   →  Plumbing, mid-market, 80 reviews          (Fit 3)
 *
 * Default: profile=high.
 */

import { NextResponse } from 'next/server';
import { isAgencyOwnerEmail, requireAgencyUserForApi } from '@/lib/auth/agency';
import { computeLlmFitScore } from '@/lib/audit/llmFitScore';
import { generateRoadmap, type RoadmapInput } from '@/lib/ai/roadmapGenerator';
import {
  generateStrategistPrep,
  type PrepInput,
} from '@/lib/ai/strategistPrep';

export const runtime = 'nodejs';
export const maxDuration = 300;

type FixtureProfile = {
  label: string;
  fitInputs: {
    revenueBand: 'low' | 'mid' | 'high' | null;
    tradeFit: boolean | null;
    metroFit: boolean | null;
    adActive: boolean | null;
    reviewCount: number | null;
  };
  roadmap: RoadmapInput;
  /** Inputs for the prep notes that don't come directly from the
   *  roadmap input or the fit breakdown. */
  prep: {
    scheduledCallTime: string;
    projectedTurfScore: number;
  };
};

const FIXTURES: Record<string, FixtureProfile> = {
  high: {
    label: 'HIGH FIT — HVAC operator, major metro, ad-active',
    fitInputs: {
      revenueBand: 'high',
      tradeFit: true,
      metroFit: true,
      adActive: true,
      reviewCount: 218,
    },
    roadmap: {
      businessName: 'Northwoods Heating & Cooling',
      trade: 'HVAC',
      keyword: 'hvac repair austin',
      market: 'Austin, TX',
      currentTurfScore: 38,
      turfReach: 22.2,
      turfRank: 2.4,
      reviewCount: 218,
      rating: 4.6,
      napFindingsSummary:
        '- Apple Maps Connect: missing\n- Yelp: NAP inconsistency (phone differs from GBP)\n- BBB: missing\n- Angi: live, NAP consistent\n- HomeAdvisor: live, but address unit-number missing',
      competitorSummary:
        '1. Air-Pro Heating: TurfScore 71, holds 58% of cells the buyer is dark in (380 reviews vs. buyer 218)\n2. ComfortMaster TX: TurfScore 64, dominates SE quadrant (NAP perfect across 14 directories)\n3. Bluebonnet HVAC: TurfScore 52, weak everywhere except 2 cells near downtown',
      cellPatternSummary:
        'Dark cells concentrated in the SE + N quadrants; visible only within ~1.5 mi of HQ. Pack appearance falls off sharply past 2 mi.',
    },
    prep: {
      scheduledCallTime: 'Wed May 15 2026 at 2:00 PM CDT',
      projectedTurfScore: 56,
    },
  },
  low: {
    label: 'LOW FIT — small landscaper, small market, no ads',
    fitInputs: {
      revenueBand: 'low',
      tradeFit: true,
      metroFit: false,
      adActive: false,
      reviewCount: 24,
    },
    roadmap: {
      businessName: 'Greenline Lawn Care',
      trade: 'Landscaping',
      keyword: 'lawn care eau claire',
      market: 'Eau Claire, WI',
      currentTurfScore: 22,
      turfReach: 11.1,
      turfRank: 2.8,
      reviewCount: 24,
      rating: 4.4,
      napFindingsSummary:
        '- Yelp: missing\n- BBB: missing\n- Angi: missing\n- HomeAdvisor: missing',
      competitorSummary:
        '1. Lakeside Landscaping: TurfScore 48 (95 reviews)\n2. Chippewa Lawn: TurfScore 41 (63 reviews)\n3. Northwoods Yard: TurfScore 35 (40 reviews)',
      cellPatternSummary:
        'Buyer appears in only 9 of 81 cells, all clustered within 1 mile of HQ. No visibility past 2 miles.',
    },
    prep: {
      scheduledCallTime: 'Wed May 15 2026 at 4:00 PM CDT',
      projectedTurfScore: 36,
    },
  },
  medium: {
    label: 'MEDIUM FIT — mid-market plumber, no ad signal',
    fitInputs: {
      revenueBand: 'mid',
      tradeFit: true,
      metroFit: true,
      adActive: null, // unknown
      reviewCount: 82,
    },
    roadmap: {
      businessName: 'Riverline Plumbing',
      trade: 'Plumbing',
      keyword: 'plumber milwaukee',
      market: 'Milwaukee, WI',
      currentTurfScore: 47,
      turfReach: 31.0,
      turfRank: 2.1,
      reviewCount: 82,
      rating: 4.7,
      napFindingsSummary:
        '- Yelp: live, NAP consistent\n- BBB: missing\n- Angi: live, NAP consistent\n- HomeAdvisor: NAP inconsistency (different street suffix)',
      competitorSummary:
        '1. Cream City Plumbing: TurfScore 68 (210 reviews, 14 directories live)\n2. Brewers Plumbing: TurfScore 61 (155 reviews)\n3. Lake Effect Plumbing: TurfScore 55 (130 reviews)',
      cellPatternSummary:
        'Buyer holds the central + W quadrants. Dark in SE and along the lakefront — coincides with where Cream City wins.',
    },
    prep: {
      scheduledCallTime: 'Thu May 16 2026 at 10:00 AM CDT',
      projectedTurfScore: 60,
    },
  },
};

export async function GET(req: Request) {
  // Gate to agency staff with fourdots-domain emails.
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  if (!isAgencyOwnerEmail(auth.email)) {
    return NextResponse.json(
      { error: 'fixture endpoint is fourdots-only' },
      { status: 403 }
    );
  }

  const url = new URL(req.url);
  const profileKey = url.searchParams.get('profile') ?? 'high';
  const fixture = FIXTURES[profileKey];
  if (!fixture) {
    return NextResponse.json(
      {
        error: `unknown profile "${profileKey}"`,
        valid: Object.keys(FIXTURES),
      },
      { status: 400 }
    );
  }

  // 1. Compute LLM Fit Score. Pure function — no external calls.
  const fitBreakdown = computeLlmFitScore(fixture.fitInputs);

  // 2. Generate the Roadmap. Calls Claude. ~$0.20.
  let roadmap;
  try {
    roadmap = await generateRoadmap(fixture.roadmap);
  } catch (e) {
    return NextResponse.json(
      {
        stage: 'roadmap',
        error: e instanceof Error ? e.message : String(e),
        fitBreakdown,
      },
      { status: 500 }
    );
  }

  // 3. Generate the Strategist Prep Notes. Calls Claude. ~$0.10.
  let prep;
  try {
    prep = await generateStrategistPrep({
      businessName: fixture.roadmap.businessName,
      trade: fixture.roadmap.trade,
      market: fixture.roadmap.market,
      scheduledCallTime: fixture.prep.scheduledCallTime,
      currentTurfScore: fixture.roadmap.currentTurfScore,
      projectedTurfScore: fixture.prep.projectedTurfScore,
      llmFitScore: fitBreakdown.score,
      llmFitBreakdown: fitBreakdown,
      napFindingsSummary: fixture.roadmap.napFindingsSummary,
      competitorSummary: fixture.roadmap.competitorSummary,
      cellPatternSummary: fixture.roadmap.cellPatternSummary,
      roadmapDiagnosis: roadmap.diagnosis,
    } satisfies PrepInput);
  } catch (e) {
    return NextResponse.json(
      {
        stage: 'prep',
        error: e instanceof Error ? e.message : String(e),
        fitBreakdown,
        roadmap,
      },
      { status: 500 }
    );
  }

  // Build a small synthetic NAP findings + competitor list parsed
  // from the fixture's free-text summaries. The viewer + PDF button
  // need structured data; the AI prompt only sees the free-text
  // summaries. This keeps the fixture single-source-of-truth for
  // the buyer profile without forcing a structured-input refactor
  // of the AI generators.
  const napFindings = parseNapFindings(fixture.roadmap.napFindingsSummary);
  const competitors = parseCompetitors(fixture.roadmap.competitorSummary);
  // Synthetic 81-cell heatmap matching the profile's described
  // pattern. In production the cells come from the buyer's
  // scan_points table; this is dev-fixture-only.
  const cells = synthesizeCellsForProfile(profileKey);

  return NextResponse.json({
    profile: profileKey,
    label: fixture.label,
    // Buyer context the PDF renderer needs (the AI generators got it
    // via prompt; the viewer + Download-PDF button need it as
    // structured fields).
    buyer: {
      businessName: fixture.roadmap.businessName,
      trade: fixture.roadmap.trade,
      market: fixture.roadmap.market,
      currentTurfScore: fixture.roadmap.currentTurfScore,
      projectedTurfScore: fixture.prep.projectedTurfScore,
      auditDate: new Date().toISOString().slice(0, 10),
      napFindings,
      competitors,
      cells,
    },
    fit: fitBreakdown,
    roadmap: {
      diagnosis: roadmap.diagnosis,
      thirtyDayTargetLift: roadmap.thirtyDayTargetLift,
      ninetyDayTargetLift: roadmap.ninetyDayTargetLift,
      generatorVersion: roadmap.generatorVersion,
      actions: roadmap.actions,
    },
    prep: {
      version: prep.version,
      keyFindings: prep.keyFindings,
      competitiveContext: prep.competitiveContext,
      selectedSegues: prep.selectedSegues.map((s) => ({
        id: s.id,
        likelyProblem: s.likelyProblem,
        verbatim: s.segue,
      })),
      talkingPoints: prep.talkingPoints,
      markdown: prep.markdown,
    },
  });
}

// ─── Free-text → structured fixture parsers ────────────────────────────
//
// The fixture profiles store NAP findings + competitor lists as
// free-text dashes-and-newlines summaries (because that's what the
// AI prompt eats). Parse those out to structured rows for the PDF
// + viewer.

function parseNapFindings(
  summary: string | null
): Array<{ status: 'MISSING' | 'INCONSISTENT' | 'LIVE'; text: string }> {
  if (!summary) return [];
  return summary
    .split('\n')
    .map((line) => line.replace(/^[\s-]+/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const lower = line.toLowerCase();
      // Order matters. "live, but address unit-number missing" contains
      // both "missing" and "live" — the inconsistency keywords have
      // to win first, otherwise the row gets a red MISSING pill when
      // it's actually a partially-functional listing with NAP issues.
      const inconsistencyHit =
        lower.includes('inconsistency') ||
        lower.includes('inconsistent') ||
        lower.includes('differs') ||
        lower.includes('mismatch') ||
        // "live, but X missing" — the "live, but" hedge is our signal
        // that the row is technically live but has quality issues.
        /\blive,\s*but\b/.test(lower);
      let status: 'MISSING' | 'INCONSISTENT' | 'LIVE';
      if (inconsistencyHit) status = 'INCONSISTENT';
      else if (lower.includes('missing')) status = 'MISSING';
      else status = 'LIVE';
      return { status, text: line };
    });
}

/**
 * Generate 81 synthetic cells matching each fixture's narrative.
 * Production reads cells from scan_points; this is the dev-only
 * stand-in that keeps the cover heatmap responsive to the profile
 * being viewed.
 *
 * Conventions: x=0..8 left→right, y=0..8 top→bottom. Center is (4,4).
 * Rank: 1 / 2 / 3 = visible in Google's local 3-pack at that
 * position. null = not in pack. (No rank > 3 — Google's local pack
 * doesn't expose any rank past 3, and the dashboard heatmap
 * collapses everything else to "absent.")
 */
function synthesizeCellsForProfile(
  profileKey: string
): Array<{ x: number; y: number; rank: number | null }> {
  const cells: Array<{ x: number; y: number; rank: number | null }> = [];
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const distFromCenter = Math.sqrt((x - 4) ** 2 + (y - 4) ** 2);
      let rank: number | null;

      if (profileKey === 'high') {
        // HVAC fixture: visible only within ~1.5mi of HQ, dark in
        // SE + N quadrants. Center top-1, near-center top-2/3,
        // outside dark.
        const inSEQuadrant = x > 5 && y > 5;
        const inNQuadrant = y < 2;
        if (inSEQuadrant || inNQuadrant) {
          rank = null;
        } else if (distFromCenter < 0.8) {
          rank = 1;
        } else if (distFromCenter < 1.5) {
          rank = 2;
        } else if (distFromCenter < 2.2) {
          rank = 3;
        } else {
          rank = null;
        }
      } else if (profileKey === 'low') {
        // Landscaper fixture: tiny TurfReach. Only ~9 cells in pack,
        // all near HQ.
        if (distFromCenter < 0.8) {
          rank = 2;
        } else if (distFromCenter < 1.4) {
          rank = 3;
        } else {
          rank = null;
        }
      } else if (profileKey === 'medium') {
        // Plumber fixture: holds central + W quadrants, dark in
        // SE + along lakefront (E edge). ~30% TurfReach.
        const inWQuadrant = x < 4;
        const inSEQuadrant = x > 5 && y > 5;
        const inEEdge = x > 6;
        if (inSEQuadrant || inEEdge) {
          rank = null;
        } else if (distFromCenter < 0.8) {
          rank = 1;
        } else if (distFromCenter < 1.5) {
          rank = 2;
        } else if (inWQuadrant && distFromCenter < 3) {
          rank = 3;
        } else if (distFromCenter < 2.4) {
          rank = 3;
        } else {
          rank = null;
        }
      } else {
        rank = null;
      }

      cells.push({ x, y, rank });
    }
  }
  return cells;
}

function parseCompetitors(
  summary: string | null
): Array<{ name: string; turfScore: number; differential?: string }> {
  if (!summary) return [];
  // Match lines like:
  //   "1. Air-Pro Heating: TurfScore 71, holds 58% of cells..."
  //   "2. ComfortMaster TX: TurfScore 64, dominates SE quadrant..."
  return summary
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(
        /^\d+\.\s*(.+?):\s*TurfScore\s+(\d+)(?:\s*[\(,—-]\s*(.+))?/i
      );
      if (!match) {
        // Best effort: take the line as a name + 0 score so we don't
        // drop competitors when the format drifts. The PDF will still
        // render the row.
        return { name: line.replace(/^\d+\.\s*/, ''), turfScore: 0 };
      }
      const [, name, score, differential] = match;
      // Don't strip trailing `)` — earlier I assumed it was a regex
      // artifact, but the fixture data legitimately contains
      // "(380 reviews vs. buyer 218)" where the closing paren is part
      // of the meaningful prose. Stripping it produced unbalanced
      // parens in the rendered PDF.
      return {
        name: name.trim(),
        turfScore: Number(score),
        differential: differential ? differential.trim() : undefined,
      };
    });
}
