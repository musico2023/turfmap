/**
 * Free DFS account-info probe — does NOT consume credit.
 * Returns account state, money balance, and (in some accounts) per-API status.
 *
 * Run with:  npx tsx scripts/dfs-account.ts
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

async function main() {
  const login = process.env.DFS_LOGIN;
  const password = process.env.DFS_PASSWORD;
  if (!login || !password) throw new Error('DFS creds missing');

  const auth =
    'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
  const res = await fetch('https://api.dataforseo.com/v3/appendix/user_data', {
    method: 'GET',
    headers: { Authorization: auth },
  });

  console.log('HTTP', res.status);
  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    console.log(text);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
