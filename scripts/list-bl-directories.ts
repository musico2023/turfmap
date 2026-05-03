/**
 * Dump BrightLocal's canonical directory list — the source of truth for
 * the slug ids we use in lib/brightlocal/directories.ts.
 *
 * Usage:
 *   npx tsx scripts/list-bl-directories.ts                 # full list
 *   npx tsx scripts/list-bl-directories.ts apple           # filter by substring
 *   npx tsx scripts/list-bl-directories.ts health vitals   # multiple filters (OR)
 *
 * Output is JSON-ish lines: <id>  [<countries>]  <url>
 *
 * Reads BRIGHTLOCAL_API_KEY from .env.local (or your shell).
 */

import { config as loadDotenv } from 'dotenv';
import path from 'node:path';

loadDotenv({ path: path.resolve(process.cwd(), '.env.local') });

const BL_BASE = 'https://api.brightlocal.com';
const ENDPOINT = '/data/v1/listings/directories';

type Directory = {
  id: string;
  countries: string[];
  url: string;
};

async function main() {
  const apiKey = process.env.BRIGHTLOCAL_API_KEY;
  if (!apiKey) {
    console.error(
      'BRIGHTLOCAL_API_KEY missing — set it in .env.local before running.'
    );
    process.exit(1);
  }

  const filters = process.argv.slice(2).map((s) => s.toLowerCase());

  const res = await fetch(`${BL_BASE}${ENDPOINT}`, {
    headers: {
      'x-api-key': apiKey,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    console.error(
      `BrightLocal HTTP ${res.status}: ${body.slice(0, 500)}`
    );
    process.exit(1);
  }
  const json = (await res.json()) as { items?: Directory[]; total_count?: number };
  const items = json.items ?? [];

  const matched = filters.length
    ? items.filter((d) =>
        filters.some(
          (f) =>
            d.id.toLowerCase().includes(f) ||
            d.url.toLowerCase().includes(f)
        )
      )
    : items;

  // Sort by id alphabetically for easy scanning.
  matched.sort((a, b) => a.id.localeCompare(b.id));

  console.log(
    `Showing ${matched.length} of ${items.length} directories${
      filters.length ? ` (filters: ${filters.join(', ')})` : ''
    }\n`
  );
  for (const d of matched) {
    const cc = d.countries?.length ? `[${d.countries.join(',')}]` : '[—]';
    console.log(`  ${d.id.padEnd(36)} ${cc.padEnd(10)} ${d.url}`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
