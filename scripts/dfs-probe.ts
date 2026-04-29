/**
 * One-shot DFS Live local_pack probe to inspect the raw response shape.
 * Useful for debugging when batches return zero tasks or unexpected structure.
 *
 * Costs ~$0.002 per run.
 *
 * Run with:  npx tsx scripts/dfs-probe.ts
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

async function main() {
  const login = process.env.DFS_LOGIN;
  const password = process.env.DFS_PASSWORD;
  if (!login || !password) {
    throw new Error('DFS_LOGIN / DFS_PASSWORD missing');
  }
  const auth =
    'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');

  const body = [
    {
      keyword: 'plumber',
      location_coordinate: '43.6532,-79.3832,1',
      language_code: 'en',
      device: 'desktop',
      tag: '4,4',
    },
  ];

  console.log('▸ POSTing one task to DFS Organic Live Advanced…');
  const res = await fetch(
    'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
    {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  console.log('HTTP', res.status);
  const text = await res.text();
  // Pretty-print if JSON
  try {
    const parsed = JSON.parse(text);
    console.log(JSON.stringify(parsed, null, 2));
    console.log('');
    console.log('── summary ──');
    console.log('top-level cost      :', parsed.cost);
    console.log('tasks_count         :', parsed.tasks_count);
    console.log('tasks_error         :', parsed.tasks_error);
    if (parsed.tasks?.[0]) {
      const t = parsed.tasks[0];
      console.log('task[0].status_code :', t.status_code);
      console.log('task[0].status_msg  :', t.status_message);
      console.log('task[0].cost        :', t.cost);
      console.log('task[0].data.tag    :', t.data?.tag);
      console.log('task[0].result?.len :', (t.result ?? []).length);

      const result0 = t.result?.[0];
      if (result0) {
        console.log('result[0].items_count :', result0.items_count);
        const items = (result0.items ?? []) as Array<Record<string, unknown>>;
        const types = items.map((it) => it.type);
        console.log('result[0].item types  :', types);

        const localPack = items.find((it) => it.type === 'local_pack');
        if (localPack) {
          console.log('── local_pack item ──');
          console.log(JSON.stringify(localPack, null, 2));
        } else {
          console.log('No local_pack item in this response.');
        }
      }
    }
  } catch {
    console.log(text);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
