/**
 * Smoke test for DFS citation checker's SIBLING-AWARE path.
 *
 * Runs two audits — one for each Kidcrew location — passing the
 * other as a sibling. Verifies that listings whose NAP matches the
 * sibling get classified as `sibling_match` (not `mismatch`), and
 * land in the `missing` list with `occupied_by_sibling` populated.
 *
 * Run with:
 *   npx tsx scripts/test-dfs-citation-check-kidcrew.ts
 *
 * Cost: ~$0.20 in DFS credits (2 audits × ~10 directories × $0.01).
 * No DB writes.
 */

import { config as loadEnv } from 'dotenv';

loadEnv({
  path: '/Users/anthonyalfonsi/Claude/turfmap/.env.local',
  override: true,
});
console.log(
  `[env-load] DFS_LOGIN_present=${!!process.env.DFS_LOGIN}`
);

import {
  runDfsCitationAudit,
  type CitationBusinessProfile,
  type SiblingLocation,
} from '../lib/citations/dfsChecker';
import {
  directoriesForProfile,
  inferDfsProfile,
} from '../lib/citations/directories';

const MIDTOWN: CitationBusinessProfile = {
  name: 'Kidcrew Medical',
  street_address: '1440 Bathurst Street',
  city: 'Toronto',
  region: 'Ontario',
  postcode: 'M5R 3J3',
  country: 'CAN',
  telephone: '(416) 654-5437',
};

const NORTH_YORK: CitationBusinessProfile = {
  name: 'Kidcrew Medical',
  street_address: '240 Duncan Mill Road',
  city: 'Toronto',
  region: 'Ontario',
  postcode: 'M3B 3S6',
  country: 'CAN',
  telephone: '(416) 654-5437',
};

const INDUSTRY = 'pediatric medical';

async function auditLocation(
  label: string,
  canonical: CitationBusinessProfile,
  sibling: CitationBusinessProfile,
  siblingLabel: string
): Promise<void> {
  console.log(`\n━━━ AUDITING: ${label} ━━━`);
  console.log(`  canonical: ${canonical.street_address}`);
  console.log(`  sibling:   ${sibling.street_address} (label="${siblingLabel}")`);

  const siblings: SiblingLocation[] = [{ ...sibling, label: siblingLabel }];
  const profile = inferDfsProfile(INDUSTRY);
  const directories = directoriesForProfile(profile, canonical.country);

  console.log(`  profile=${profile}, dirs=${directories.length}`);

  const t0 = Date.now();
  const result = await runDfsCitationAudit(canonical, directories, siblings);
  const elapsedMs = Date.now() - t0;

  console.log(`  done in ${(elapsedMs / 1000).toFixed(1)}s, cost $${result.total_cost_dollars.toFixed(4)}`);
  console.log('');
  console.log('  per-directory:');
  for (const row of result.per_directory_summary) {
    const status = row.status.padEnd(11);
    const dir = row.label.padEnd(20);
    let detail = '';
    if (row.url) detail = row.url.slice(0, 60);
    else if (row.error) detail = `(${row.error.slice(0, 60)})`;
    else detail = '(not found)';
    console.log(`    ${status} ${dir} ${detail}`);
  }
  console.log('');

  const siblingMatches = result.findings.citations.filter(
    (c) => c.status === 'sibling_match'
  );
  const occupied = result.findings.missing.filter((m) => m.occupied_by_sibling);
  console.log('  SIBLING-AWARE OUTCOMES:');
  console.log(`    citations status=sibling_match:        ${siblingMatches.length}`);
  console.log(`    missing with occupied_by_sibling set:  ${occupied.length}`);
  if (occupied.length > 0) {
    for (const o of occupied) {
      console.log(`      • ${o.directory} → occupied by "${o.occupied_by_sibling?.sibling_label}" (${o.occupied_by_sibling?.sibling_address})`);
    }
  }

  console.log('');
  console.log('  FINDINGS:');
  console.log(`    citations:       ${result.findings.citations.length}`);
  console.log(`    inconsistencies: ${result.findings.inconsistencies.length}`);
  console.log(`    missing:         ${result.findings.missing.length}`);
}

async function main(): Promise<void> {
  // First: audit Midtown, treating North York as sibling
  await auditLocation('Midtown Toronto', MIDTOWN, NORTH_YORK, 'North York');
  // Then: audit North York, treating Midtown as sibling
  await auditLocation('North York', NORTH_YORK, MIDTOWN, 'Midtown Toronto');
}

main().catch((e) => {
  console.error('[smoke-kidcrew] FAILED:', e);
  process.exit(1);
});
