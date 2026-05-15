/**
 * Smoke test for the DFS-based citation checker.
 *
 * Runs a real DFS citation audit against Ryan / BVM Contracting using
 * his actual NAP from production Supabase. Prints per-directory
 * results + cost so we can sanity-check accuracy before wiring this
 * into autoAudit.ts.
 *
 * Run with:
 *   npx tsx scripts/test-dfs-citation-check.ts
 *
 * Cost: ~$0.024 in DFS credits (12 directories × $0.002 Live Advanced).
 * No DB writes. No persistence. Read-only check.
 */

import { config as loadEnv } from 'dotenv';

// Same env-load trick as scripts/generate-ryan-audit-pdf.ts —
// .env.local is in the parent (non-worktree) repo.
const baseResult = loadEnv({
  path: '/Users/anthonyalfonsi/Claude/turfmap/.env.local',
  override: true,
});
console.log(
  `[env-load] parsed keys=${Object.keys(baseResult.parsed ?? {}).length} ` +
    `DFS_LOGIN_present=${!!process.env.DFS_LOGIN}`
);

import { runDfsCitationAudit, type CitationBusinessProfile } from '../lib/citations/dfsChecker';
import { directoriesForProfile, inferDfsProfile } from '../lib/citations/directories';

// Ryan's NAP — same values as scripts/generate-ryan-audit-pdf.ts.
const RYAN: CitationBusinessProfile = {
  name: 'BVM Contracting',
  street_address: '80 Barbados Boulevard',
  city: 'Toronto',
  region: 'Ontario',
  postcode: 'M1J 0A2',
  country: 'CAN',
  telephone: '6474489603',
};
const RYAN_INDUSTRY = 'General contractor (custom homes / renovations)';

async function main(): Promise<void> {
  const profile = inferDfsProfile(RYAN_INDUSTRY);
  const directories = directoriesForProfile(profile, RYAN.country);
  console.log(
    `[smoke] profile=${profile} directories=${directories.length} (${directories
      .map((d) => d.id)
      .join(', ')})`
  );
  console.log('[smoke] Running DFS citation audit…');

  const t0 = Date.now();
  const result = await runDfsCitationAudit(RYAN, directories);
  const elapsedMs = Date.now() - t0;

  console.log(`[smoke] done in ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`[smoke] total DFS cost: $${result.total_cost_dollars.toFixed(4)}`);
  console.log('');
  console.log('PER-DIRECTORY:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const row of result.per_directory_summary) {
    const status = row.status.padEnd(11);
    const label = row.label.padEnd(28);
    const url = row.url ? row.url.slice(0, 70) : row.error ? `(error: ${row.error.slice(0, 50)})` : '(not found)';
    console.log(`  ${status} ${label} ${url}`);
  }
  console.log('');
  console.log('FINDINGS SUMMARY:');
  console.log(`  citations:       ${result.findings.citations.length}`);
  console.log(`  inconsistencies: ${result.findings.inconsistencies.length}`);
  console.log(`  missing:         ${result.findings.missing.length}`);

  if (result.findings.inconsistencies.length > 0) {
    console.log('');
    console.log('INCONSISTENCIES:');
    for (const inc of result.findings.inconsistencies) {
      console.log(`  ${inc.directory} — ${inc.field}:`);
      console.log(`    canonical: ${inc.canonical}`);
      console.log(`    found:     ${inc.found}`);
      console.log(`    url:       ${inc.citation_url}`);
    }
  }
}

main().catch((e) => {
  console.error('[smoke] FAILED:', e);
  process.exit(1);
});
