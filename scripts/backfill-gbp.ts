/**
 * Backfill Google Places enrichment for existing client_locations rows.
 *
 * Run with:  npm run backfill:gbp
 *
 * Walks every client_locations row that:
 *   - has lat/lng populated, AND
 *   - has google_place_match_status IS NULL OR 'no_match' (i.e. never
 *     successfully matched, AND operator hasn't already rejected /
 *     manually picked something)
 *
 * For each, runs the same Find Place + strict-match flow as the
 * onboarding hook. Auto-matches land with status='auto' so the
 * locations panel surfaces a confirm/reject badge — operator does
 * the final accuracy pass out-of-band.
 *
 * Cost: ~$0.025 per location. The script prints a running cost total.
 *
 * Idempotent: re-running skips locations that already have a non-null,
 * non-'no_match' status. Use `--force` to re-process 'no_match' rows
 * (e.g. if you've fixed a wrong address since the last run).
 *
 * Flags:
 *   --dry-run    list what would be processed; no API calls
 *   --force      re-process rows currently in 'no_match' state
 *   --limit=N    cap to N locations (smoke-test before fan-out)
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { getServerSupabase } from '../lib/supabase/server';
import { enrichLocationFromOnboarding } from '../lib/google/enrich';

type RowToProcess = {
  id: string;
  client_id: string;
  label: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  google_place_match_status: string | null;
  business_name: string;
  client_status: string;
};

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const force = args.has('--force');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : null;

  if (!process.env.GOOGLE_PLACES_API_KEY && !dryRun) {
    console.error(
      'GOOGLE_PLACES_API_KEY is not set. Configure it in .env.local before running (or pass --dry-run to preview).'
    );
    process.exit(1);
  }

  const supabase = getServerSupabase();

  // Pull every candidate location with the parent client's brand name +
  // status, server-side joined. Skip churned clients (no value enriching
  // a departed customer's data).
  const { data: rows, error } = await supabase
    .from('client_locations')
    .select(
      `id, client_id, label, city, latitude, longitude,
       google_place_match_status,
       clients!inner(business_name, status)`
    )
    .not('latitude', 'is', null)
    .not('longitude', 'is', null)
    .returns<
      Array<{
        id: string;
        client_id: string;
        label: string | null;
        city: string | null;
        latitude: number | null;
        longitude: number | null;
        google_place_match_status: string | null;
        clients: { business_name: string; status: string };
      }>
    >();
  if (error) {
    console.error('query failed:', error.message);
    process.exit(1);
  }

  const candidates: RowToProcess[] = (rows ?? [])
    .filter((r) => r.clients.status !== 'churned')
    .filter((r) => {
      // Skip rows already in a terminal state set by the operator.
      if (
        r.google_place_match_status === 'auto' ||
        r.google_place_match_status === 'confirmed' ||
        r.google_place_match_status === 'manual' ||
        r.google_place_match_status === 'rejected'
      ) {
        return false;
      }
      // 'no_match' is auto-set by a prior enrich run that came up empty.
      // Skip unless --force is passed.
      if (r.google_place_match_status === 'no_match' && !force) return false;
      return true;
    })
    .map((r) => ({
      id: r.id,
      client_id: r.client_id,
      label: r.label,
      city: r.city,
      latitude: r.latitude,
      longitude: r.longitude,
      google_place_match_status: r.google_place_match_status,
      business_name: r.clients.business_name,
      client_status: r.clients.status,
    }));

  const work = limit !== null ? candidates.slice(0, limit) : candidates;

  console.log(
    `[backfill-gbp] candidates=${candidates.length} processing=${work.length}${
      dryRun ? ' (dry-run)' : ''
    }${force ? ' (force)' : ''}${limit !== null ? ` (limit=${limit})` : ''}`
  );

  if (work.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (dryRun) {
    for (const r of work) {
      console.log(
        `  - ${r.business_name} / ${r.label ?? r.city ?? '(no label)'} (${r.id}) — current status: ${r.google_place_match_status ?? 'null'}`
      );
    }
    console.log(
      `\nEstimated cost if run for real: ~$${(work.length * 0.025).toFixed(2)} (assuming all match)`
    );
    return;
  }

  let matched = 0;
  let noMatch = 0;
  let skipped = 0;
  let totalCostCents = 0;

  // Sequential to keep Google quota usage predictable. ~500ms per
  // location; 100 locations ≈ 50s.
  for (const r of work) {
    const result = await enrichLocationFromOnboarding(supabase, {
      locationId: r.id,
      businessName: r.business_name,
      latitude: r.latitude,
      longitude: r.longitude,
    });
    const tag = `${r.business_name} / ${r.label ?? r.city ?? r.id}`;
    if (result.status === 'matched') {
      matched += 1;
      totalCostCents += result.costCents;
      console.log(
        `  ✓ ${tag} — matched (dist=${result.matchDistanceM.toFixed(0)}m sim=${result.matchNameSimilarity.toFixed(2)})`
      );
    } else if (result.status === 'no_match') {
      noMatch += 1;
      totalCostCents += result.costCents;
      console.log(`  ∅ ${tag} — no match (within 100m + name similarity)`);
    } else {
      skipped += 1;
      console.log(`  – ${tag} — skipped (${result.reason})`);
    }
  }

  console.log(
    `\n[backfill-gbp] done. matched=${matched} no_match=${noMatch} skipped=${skipped} cost=$${(totalCostCents / 100).toFixed(2)}`
  );
  console.log(
    `Auto-matched rows are now status='auto' — operator should review via the locations panel and confirm/reject each one.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
