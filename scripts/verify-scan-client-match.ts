/**
 * Guard: the scan's "is this listing the client?" matcher must not
 * credit another business's local-pack rankings to the client.
 *
 * lib/scans/runScan.ts used to identify the client's own listing with
 * `new RegExp(business_name.split(' ')[0], 'i')` — an unanchored
 * substring match on the first word. In production that made
 * "Clear Choice Windows & Doors" match "Clear Works" (/clear/i),
 * inflating TurfScore 10 → 24 and TurfReach 19% → 40% on a Portland
 * metro grid: 17 of 32 "ranked" cells belonged to a different company,
 * several of them #1.
 *
 * The matcher now delegates to nameMatches (lib/citations/napCompare),
 * so this guard pins the behaviour that regression depended on. The
 * cases below are the ones a naive matcher gets wrong — each is a
 * shape that has actually bitten us somewhere in the codebase.
 *
 * Run: npx tsx scripts/verify-scan-client-match.ts  (part of npm run verify)
 */

import { nameMatches } from '../lib/citations/napCompare';
import { cleanCompetitorName } from '../lib/dataforseo/cleanCompetitorName';

// Mirrors the predicate in lib/scans/runScan.ts. Kept in sync by this
// guard: if runScan's matcher changes shape, update here too.
//
// `gbpName` is the location's Google Business Profile display name
// (gbp_signals.raw.displayName) — null when the location was never
// enriched. Either name matching counts as the client's listing.
const isClientListing = (
  businessName: string,
  title: unknown,
  gbpName: string | null = null
): boolean => {
  const cleaned = cleanCompetitorName(String(title ?? ''));
  return [businessName, gbpName]
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    .some((n) => nameMatches(n, cleaned));
};

type Case = {
  business: string;
  title: string;
  /** GBP display name for the location, when it differs from `business`. */
  gbpName?: string | null;
  expect: boolean;
  why: string;
};

const CASES: Case[] = [
  // ─── The regression that prompted this guard ────────────────────────
  {
    business: 'Clear Choice Windows & Doors',
    title: 'Clear Works',
    expect: false,
    why: 'shares only the first word — the original /clear/i false positive',
  },
  {
    business: 'Clear Choice Windows & Doors',
    title: 'Clear Choice Windows and Doors',
    expect: true,
    why: '"&" vs "and" is pure formatting variance',
  },
  {
    business: 'Clear Choice Windows & Doors',
    title: 'Clear Choice Windows & Doors LLC',
    expect: true,
    why: 'legal suffix on the listing must not break the match',
  },
  {
    business: 'Clear Choice Windows & Doors',
    title: 'Renewal by Andersen of Portland',
    expect: false,
    why: 'unrelated competitor, zero shared distinctive tokens',
  },

  // ─── Generic first words: the broad blast radius ────────────────────
  {
    business: 'All Season Windows, Siding & Roofing',
    title: 'All Star Roofing',
    expect: false,
    why: '"All" is a very common home-services first word',
  },
  {
    business: 'Precision Garage Door',
    title: 'Precision Auto Glass',
    expect: false,
    why: 'shared generic first word, different trade entirely',
  },
  {
    business: 'Elite Plumbing Co',
    title: 'Elite Roofing & Exteriors',
    expect: false,
    why: 'shared generic first word, different trade',
  },

  // ─── Shapes nameMatches is specifically hardened for ────────────────
  {
    business: 'Logik',
    title: 'Logik Plumbing & Heating',
    expect: true,
    why: 'single-word brand must still match a qualifier-rich title',
  },
  {
    business: 'On Point Plumbing',
    title: 'Pinpoint Drain Services',
    expect: false,
    why: 'load-bearing stopword must not collapse to a "point" substring',
  },
  {
    business: 'CertaPro Painters of Calgary and Central Alberta',
    title: 'CertaPro Painters of Edmonton',
    expect: false,
    why: 'sibling franchise in another city is a different location',
  },
  {
    business: 'CertaPro Painters of Calgary and Central Alberta',
    title: 'CertaPro Painters Calgary, Alberta',
    expect: true,
    why: 'short listing title of the same franchise location',
  },

  // ─── DFS chrome leaking into the title ──────────────────────────────
  {
    business: 'Clear Choice Windows & Doors',
    title: 'Clear Choice Windows & Doors        My Ad Center',
    expect: true,
    why: 'scraped Google UI label must be stripped before matching',
  },

  // ─── GBP display name diverging from the operator-typed name ────────
  // Both of these are real production rows. Matching on business_name
  // alone scores them at zero reach despite ranking in most cells.
  {
    business: 'D Spot Dessert Cafe',
    gbpName: 'D Spot Desserts Winnipeg',
    title: 'D Spot Desserts Winnipeg',
    expect: true,
    why: 'GBP name is what the local pack shows; typed name is stale',
  },
  {
    business: 'BVM Contracting',
    gbpName: 'BVM Homes',
    title: 'BVM Homes',
    expect: true,
    why: 'operator-confirmed GBP name differs from the typed name',
  },
  {
    business: 'D Spot Dessert Cafe',
    gbpName: 'D Spot Desserts Winnipeg',
    title: 'Snow & Moon Dessert Cafe',
    expect: false,
    why: 'a second name to match on must not become a second way to be wrong',
  },
  {
    business: 'D Spot Dessert Cafe',
    gbpName: null,
    title: 'Arctic Dessertz',
    expect: false,
    why: 'un-enriched location falls back to the typed name only',
  },

  // ─── Inputs that broke the unescaped `new RegExp` path ──────────────
  {
    business: 'A+ Windows',
    title: 'Barnaby Auto Glass',
    expect: false,
    why: 'old code compiled /a+/i and matched almost any title',
  },
  {
    business: 'Sunshine (Pacific) Roofing',
    title: 'Northwest Exteriors',
    expect: false,
    why: 'unbalanced-paren name used to throw when compiled as a regex',
  },
];

function main() {
  const failures: string[] = [];

  for (const c of CASES) {
    let actual: boolean;
    try {
      actual = isClientListing(c.business, c.title, c.gbpName ?? null);
    } catch (e) {
      failures.push(
        `THREW  "${c.business}" vs "${c.title}" — ${e instanceof Error ? e.message : String(e)}`
      );
      continue;
    }
    if (actual !== c.expect) {
      failures.push(
        `${c.expect ? 'MISSED' : 'FALSE+'} "${c.business}" vs "${c.title}" ` +
          `— expected ${c.expect}, got ${actual} (${c.why})`
      );
    }
  }

  // Null/empty titles must be a clean false, never a throw — DFS returns
  // items without a title occasionally and a scan must not die on one.
  for (const bad of [null, undefined, '', '   ']) {
    try {
      if (isClientListing('Clear Choice Windows & Doors', bad) !== false) {
        failures.push(`FALSE+ empty title ${JSON.stringify(bad)} matched`);
      }
    } catch (e) {
      failures.push(
        `THREW  empty title ${JSON.stringify(bad)} — ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  // An empty business name must never match anything — a blank client
  // name matching every listing would score a phantom 100.
  for (const title of ['Clear Works', 'Renewal by Andersen of Portland']) {
    if (isClientListing('', title) !== false) {
      failures.push(`FALSE+ empty business name matched "${title}"`);
    }
  }

  if (failures.length > 0) {
    console.error('✗ scan client-match guard failed:\n');
    for (const f of failures) console.error(`   ${f}`);
    console.error(
      `\n${failures.length} failure(s). The scan matcher must not credit ` +
        `another business's rankings to the client.`
    );
    process.exit(1);
  }

  console.log(
    `✓ scan client-match guard — ${CASES.length} name cases + empty-input ` +
      `handling all pass`
  );
}

main();
