/**
 * Dev preview: synthesize a Strategy Session fixture and render the
 * Roadmap PDF locally so we can eyeball the layout.
 *
 * Run: npx tsx scripts/preview-strategy-pdf.tsx
 */
import { renderToBuffer } from '@react-pdf/renderer';
import { RoadmapPdf, type RoadmapPdfData } from '../components/pdf/RoadmapPdf';
import React from 'react';
import { writeFileSync } from 'node:fs';

function synthCells(seed: number) {
  const cells: Array<{ x: number; y: number; rank: number | null }> = [];
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const d = Math.hypot(x - 4, y - 4);
      const r = (Math.sin(seed + x * 0.7 + y * 1.3) + 1) / 2;
      let rank: number | null = null;
      if (d < 1.5 && r > 0.3) rank = 1;
      else if (d < 2.5 && r > 0.4) rank = 2;
      else if (d < 3.5 && r > 0.6) rank = 3;
      cells.push({ x, y, rank });
    }
  }
  return cells;
}

const data: RoadmapPdfData = {
  businessName: 'Acme Plumbing',
  trade: 'plumbing',
  market: 'Toronto, ON',
  auditDate: '2026-05-28',
  currentTurfScore: 42,
  projectedTurfScore: 58,
  diagnosis:
    "Across the three keywords scanned, 'plumber toronto' has your strongest visibility, while 'water heater repair toronto' is your largest opportunity gap. 'Drain cleaning toronto' is the most contested — three competitors hold the top-3 across most of your service area.",
  actions: [
    { week: 1, action: 'Update GBP categories to add Water Heater Repair', category: 'gbp_optimization', pillar: 'visibility', difficulty: 'DIY-easy', priority: 'HIGH', projectedScoreLift: 5, llmCovered: true },
    { week: 1, action: 'Set up review request automation for new jobs', category: 'review_velocity', pillar: 'systems', difficulty: 'DIY-medium', priority: 'HIGH', projectedScoreLift: 6, llmCovered: true },
    { week: 2, action: 'Claim Yelp, Angi, and HomeAdvisor listings', category: 'directory_claiming', pillar: 'visibility', difficulty: 'DIY-medium', priority: 'MEDIUM', projectedScoreLift: 4, llmCovered: true },
    { week: 3, action: 'Add 10 fresh GBP photos showing recent jobs', category: 'gbp_photos', pillar: 'visibility', difficulty: 'DIY-easy', priority: 'MEDIUM', projectedScoreLift: 3, llmCovered: true },
    { week: 6, action: 'Implement LocalBusiness schema with full NAP', category: 'schema_integration', pillar: 'visibility', difficulty: 'DIY-hard', priority: 'HIGH', projectedScoreLift: 4, llmCovered: true },
  ],
  napFindings: [],
  competitors: [],
  cells: synthCells(0.3),
  ninetyDayTargetLift: 22,
  tierLabel: 'Strategy Session',
  keywordLandscape: [
    { keyword: 'plumber toronto', turfScore: 42, turfReach: 46, turfRank: 2.1, note: 'Primary — the 90-day Roadmap on the following pages is framed around this keyword.', cells: synthCells(0.3) },
    { keyword: 'drain cleaning toronto', turfScore: 28, turfReach: 31, turfRank: 2.6, cells: synthCells(1.8) },
    { keyword: 'water heater repair toronto', turfScore: 19, turfReach: 18, turfRank: 2.8, cells: synthCells(3.1) },
  ],
};

async function main() {
  const buf = await renderToBuffer(React.createElement(RoadmapPdf, { data }));
  writeFileSync('/tmp/strategy-roadmap-sample.pdf', buf);
  console.log('Rendered', buf.length, 'bytes to /tmp/strategy-roadmap-sample.pdf');
}
main();
