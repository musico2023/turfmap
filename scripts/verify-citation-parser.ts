/**
 * Guard for the DFS citation checker's parsing + classification.
 *
 * Every fixture below is a real failure or a real address from production:
 * Five Star Painting of Austin's audit (2026-09-16) reported "00 AM" as a
 * HomeAdvisor address mismatch, "248 Photos" as its Yelp address, and — via
 * a DFS 40101 — "no Google Business Profile" for a 470-review listing. The
 * addresses are clients onboarded this month, so they're known-good.
 *
 * Network-free: the audit-level checks use a verified place_id with only the
 * google_business directory, which short-circuits before any DFS call.
 */
import {
  extractAddressFromSnippet,
  describeMismatch,
  probeOutcome,
  verifiedGbpCitation,
  runDfsCitationAudit,
  dfsTaskError,
  DFS_NO_RESULTS_CODE,
  shouldRetryAbsent,
  mergeRecallRetry,
} from '../lib/citations/dfsChecker';
import { classifyCitation, addressMatches } from '../lib/citations/napCompare';
import { locationToCitationProfile } from '../lib/brightlocal/autoAudit';
import { directoriesForProfile } from '../lib/citations/directories';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (!cond) { console.error(`✗ ${name}${detail !== undefined ? `  → ${JSON.stringify(detail)}` : ''}`); failures++; }
  else console.log(`✓ ${name}`);
}

(async () => {
  // ── address extraction: the incident ──────────────────────────────────
  const hours = extractAddressFromSnippet('Five Star Painting of Austin. Open today 8:00 AM - 6:00 PM. Free estimates.');
  check('business hours are not an address ("00 AM")', hours === null, hours);
  const photos = extractAddressFromSnippet('248 Photos · 470 Reviews · Painters in Austin');
  check('photo count is not an address ("248 Photos")', photos === null, photos);
  const rated = extractAddressFromSnippet('Rated 4.9 from 470 reviews since 2005.');
  check('review count is not an address', rated === null, rated);
  const along = extractAddressFromSnippet('Proudly serving 248 customers along the way.');
  check('count noun rejected even when a suffix follows', along === null, along);
  check('null snippet → null', extractAddressFromSnippet(null) === null);

  // ── address extraction: real addresses must still parse ───────────────
  const cases: [string, string][] = [
    ['500 N Capital of Texas Hwy Bldg 2, Austin, TX 78746', '500 N Capital of Texas Hwy'],
    ['13661 Balsam Ln N, Dayton, MN 55327', '13661 Balsam Ln N'],
    ['7244 SW Durham Rd #900, Tigard, OR 97224', '7244 SW Durham Rd'],
    ['4944 Neo Pkwy, Garfield Heights, OH 44128', '4944 Neo Pkwy'],
    ['2740 SW Martin Downs Blvd, Palm City, FL 34990', '2740 SW Martin Downs Blvd'],
    ['Call (512) 379-6517 · 2842 N Business Park Ave, Fresno', '2842 N Business Park Ave'],
  ];
  for (const [snippet, expected] of cases) {
    const got = extractAddressFromSnippet(snippet);
    check(`parses "${expected}"`, got === expected, got);
  }
  check('lowercase connector no longer truncates ("Capital of Texas")',
    extractAddressFromSnippet('500 N Capital of Texas Hwy')?.includes('Texas') === true);

  // ── classification: SAB can't mismatch against nothing ────────────────
  check('SAB (no canonical address) + found address → unverified, not mismatch',
    classifyCitation(
      { name: 'Painter Bros of Indianapolis', phone: null, address: '' },
      { name: 'Painter Bros of Indianapolis', phone: null, address: '123 Main St' }
    ) === 'unverified');
  check('real address mismatch still flagged',
    classifyCitation(
      { name: 'Five Star Painting of Austin', phone: null, address: '500 N Capital of Texas Hwy' },
      { name: 'Five Star Painting of Austin', phone: null, address: '9 Congress Ave' }
    ) === 'mismatch');
  check('real phone mismatch still flagged',
    classifyCitation(
      { name: 'Five Star Painting of Austin', phone: '5123796517', address: '' },
      { name: 'Five Star Painting of Austin', phone: '5125550000', address: null }
    ) === 'mismatch');
  check('phone match still wins over garbage address',
    classifyCitation(
      { name: 'Five Star Painting of Austin', phone: '(512) 379-6517', address: '500 N Capital of Texas Hwy' },
      { name: 'Five Star Painting of Austin', phone: '(512) 379-6517', address: null }
    ) === 'matched');

  // ── address comparison: same place, different spelling ────────────────
  // All from the 2026-09-17 backfill, where a now-working parser exposed that
  // the comparator treated abbreviations as different addresses.
  check('"13661 Balsam Ln." = "13661 Balsam Lane North" (CertaPro NW, flagged on 2 dirs)',
    addressMatches('13661 Balsam Lane North', '13661 Balsam Ln.'));
  check('"25 Amy Croft Dr" = "25 Amy Croft Drive" (D Spot sibling)',
    addressMatches('25 Amy Croft Dr', '25 Amy Croft Drive'));
  check('unit designator ignored ("Rd Unit 4" = "Rd")',
    addressMatches('1475 Huron Church Rd Unit 4', '1475 Huron Church Rd'));
  check('"#900" suite ignored',
    addressMatches('7244 SW Durham Rd #900', '7244 Southwest Durham Road'));
  check('"500 North Capital of Texas Highway" = "500 N Capital Of Texas Hwy"',
    addressMatches('500 North Capital of Texas Highway', '500 N Capital Of Texas Hwy'));
  // …but genuinely different addresses must stay different.
  check('conflicting directionals differ ("100 N Main St" ≠ "100 S Main St")',
    !addressMatches('100 N Main St', '100 S Main St'));
  check('different house numbers differ (CertaPro Calgary vs its BBB address)',
    !addressMatches('908 53 Avenue Northeast', '4999 43 St SE'));
  check('CertaPro NW no longer classified a mismatch',
    classifyCitation(
      { name: 'CertaPro Painters of Northwest Metro Minneapolis, MN', phone: null, address: '13661 Balsam Lane North' },
      { name: 'CertaPro Painters of Northwest Metro Minneapolis, MN', phone: null, address: '13661 Balsam Ln.' }
    ) === 'matched');

  // Stray leading number glued onto the real one (CertaPro Calgary's BBB).
  const glued = extractAddressFromSnippet('143 4999 43 St SE, Calgary, AB');
  check('stray leading number stripped ("143 4999 43 St SE" → "4999 43 St SE")', glued === '4999 43 St SE', glued);
  const numbered = extractAddressFromSnippet('908 53 Avenue Northeast, Calgary');
  check('numbered street kept ("908 53 Avenue Northeast")', numbered === '908 53 Avenue Northeast', numbered);

  // ── recall retry ──────────────────────────────────────────────────────
  const hi = { priority: 'high' }, med = { priority: 'medium' };
  check('retry: high-priority absent → retried', shouldRetryAbsent({ error: null, url: null, directory: hi }));
  check('retry: medium-priority absent → not retried', !shouldRetryAbsent({ error: null, url: null, directory: med }));
  check('retry: errored → not retried (already retried at task level)', !shouldRetryAbsent({ error: 'x', url: null, directory: hi }));
  check('retry: found → not retried', !shouldRetryAbsent({ error: null, url: 'https://bbb.org/x', directory: hi }));
  const absent = { error: null, url: null, cost_dollars: 0.002, tag: 'first' };
  const found = mergeRecallRetry(absent, { error: null, url: 'https://www.bbb.org/p', cost_dollars: 0.002, tag: 'retry' });
  check('merge: retry that finds the listing wins', found.url === 'https://www.bbb.org/p' && found.tag === 'retry');
  check('merge: cost is summed', Math.abs(found.cost_dollars - 0.004) < 1e-9);
  const erroredRetry = mergeRecallRetry(absent, { error: '40101', url: null, cost_dollars: 0.002, tag: 'retry' });
  check('merge: errored retry keeps the original absent answer', erroredRetry.tag === 'first' && erroredRetry.error === null);

  // ── mismatch labelling ────────────────────────────────────────────────
  const addr = describeMismatch(
    { name: 'Five Star Painting of Austin', phone: null, address: '500 N Capital of Texas Hwy' },
    { name: 'Five Star Painting of Austin', phone: null, address: '9 Congress Ave' }
  );
  check('address mismatch labelled "address" (was "name")', addr.field === 'address', addr);
  check('address mismatch pairs address with address',
    addr.canonical === '500 N Capital of Texas Hwy' && addr.found === '9 Congress Ave', addr);
  const phone = describeMismatch(
    { name: 'X Co', phone: '5123796517', address: '' },
    { name: 'X Co', phone: '5125550000', address: null }
  );
  check('phone mismatch labelled "phone"', phone.field === 'phone' && phone.found === '5125550000', phone);

  // ── probe outcome: an error is unknown, not absent ────────────────────
  check('DFS error → errored', probeOutcome({ error: 'DFS task 40101: Internal SE Server Error.', url: null }) === 'errored');
  check('error wins even with a url', probeOutcome({ error: 'timeout', url: 'https://x' }) === 'errored');
  check('no result → absent', probeOutcome({ error: null, url: null }) === 'absent');
  check('result → found', probeOutcome({ error: null, url: 'https://www.yelp.com/biz/x' }) === 'found');

  // Regression: 40102 is "no results" — an answer. Counting it as an error
  // hid real gaps and could fail whole audits for thin-footprint businesses.
  check('DFS 40102 (no results) is not an error', dfsTaskError(40102, 'No Search Results.') === null);
  check('DFS 20000 is not an error', dfsTaskError(20000, 'Ok.') === null);
  check('DFS 40101 (capacity) IS an error', dfsTaskError(40101, 'Internal SE Server Error.')?.includes('40101') === true);
  check('40102 probe classifies as absent, not errored',
    probeOutcome({ error: dfsTaskError(DFS_NO_RESULTS_CODE, 'No Search Results.'), url: null }) === 'absent');

  // ── verified GBP short-circuit ────────────────────────────────────────
  const base = {
    name: 'Five Star Painting of Austin', street_address: '500 North Capital of Texas Highway',
    city: 'Austin', region: 'Texas', postcode: '78746', country: 'USA',
    telephone: '+1 512-379-6517', latitude: 30.3084212, longitude: -97.8274223,
  };
  check('no place_id → no short-circuit', verifiedGbpCitation(base) === null);
  const gbp = verifiedGbpCitation({ ...base, google_place_id: 'ChIJE_AhvlNJW4YRS-g3v_i5Sqo' });
  check('verified place_id → matched google_business citation',
    gbp?.status === 'matched' && gbp.directory === 'google_business' && gbp.url.includes('ChIJE_AhvlNJW4YRS-g3v_i5Sqo'), gbp);

  const gbpDirs = directoriesForProfile('home-services', 'USA').filter((d) => d.id === 'google_business');
  const audit = await runDfsCitationAudit({ ...base, google_place_id: 'ChIJE_AhvlNJW4YRS-g3v_i5Sqo' }, gbpDirs);
  check('audit: verified GBP is NOT reported missing', !audit.findings.missing.some((m) => m.directory === 'google_business'), audit.findings.missing);
  check('audit: verified GBP counted as a citation', audit.findings.citations.some((c) => c.directory === 'google_business' && c.status === 'matched'));
  check('audit: no DFS probe spent on a verified GBP', audit.probed_count === 0 && audit.total_cost_dollars === 0, audit);
  check('audit: result exposes errored_directories', Array.isArray(audit.errored_directories));

  // ── profile builder passes place_id only when trustworthy ─────────────
  const loc = {
    phone: '+1 512-379-6517', street_address: '500 North Capital of Texas Highway', city: 'Austin',
    region: 'Texas', postcode: '78746', country_code: 'USA', latitude: 30.30842, longitude: -97.82742,
  };
  check('manual match → place_id passed',
    locationToCitationProfile('Five Star Painting of Austin', { ...loc, google_place_id: 'ChIJ_a', google_place_match_status: 'manual' })?.google_place_id === 'ChIJ_a');
  check('rejected match → probed as before',
    locationToCitationProfile('Five Star Painting of Austin', { ...loc, google_place_id: 'ChIJ_a', google_place_match_status: 'rejected' })?.google_place_id === null);
  check('no place_id → probed as before',
    locationToCitationProfile('Five Star Painting of Austin', loc)?.google_place_id === null);

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nAll citation-parser checks passed.');
})();
