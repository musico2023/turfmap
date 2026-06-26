/**
 * One-off dogfood for the v1 competitor keyword reveal builder.
 * Runs buildCompetitorReveal against Logik's roofing scan with
 * representative inputs and prints the summary + real DFS cost.
 *
 *   tsx scripts/dogfood-competitor-reveal.ts
 */
import { config } from 'dotenv';
import path from 'node:path';
config({ path: path.resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '@/lib/supabase/server';
import { buildCompetitorReveal } from '@/lib/keywords/competitorReveal';

async function main() {
  const supabase = getServerSupabase();

  const res = await buildCompetitorReveal(supabase, {
    // Logik Roofing & Insulation Oshawa — roofing scan 2026-06-22.
    scanId: 'f72c8a7a-c392-4d37-ac36-33f50d18dd6b',
    ownName: 'Logik Roofing & Insulation Oshawa',
    // Representative overrides (stored record has industry='insulation',
    // city=null, country='USA' — all data-quality gaps; Logik is a roofing
    // business in Oshawa, ON, Canada).
    industry: 'roofing',
    city: 'Oshawa',
    countryCode: 'CAN',
    lat: 43.8554075,
    lng: -78.881788,
    scannedKeyword: 'roofing oshawa',
  });

  console.log('\n── Competitor reveal result ──');
  console.log(JSON.stringify(res, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
