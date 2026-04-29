/**
 * DataForSEO SERP API wrapper.
 *
 * All DFS calls in TurfMap MUST go through this module.
 *
 * Endpoint: POST /v3/serp/google/organic/live/advanced
 *   - One task per request (DFS Live mode is single-task only)
 *   - $0.002 / request
 *   - Returns parsed SERP including local_pack items as flat siblings of
 *     organic items (each `type === 'local_pack'`, with rank_group 1..3).
 *
 * For 81 grid points we issue 81 concurrent requests at a bounded
 * parallelism limit and aggregate per-task cost.
 *
 * Standard Queue (`task_post` / `task_get`, ~$0.0006) is the cheaper path
 * used by scheduled scans — stub for Phase 3.
 */

import type { GridPoint } from './grid';

const DFS_BASE_URL = 'https://api.dataforseo.com';
const DFS_LIVE_ADVANCED = '/v3/serp/google/organic/live/advanced';

/** Max concurrent in-flight requests during a scan. */
const DFS_CONCURRENCY = 10;

/** Search radius (km) the upstream API uses for each grid-point query. */
const DFS_QUERY_RADIUS_KM = 1;

/**
 * DFS task-level error codes that are worth one automatic retry.
 *
 * 40207 ("IP not whitelisted") shows up sporadically on dual-stack networks
 * even when the IP IS whitelisted — outbound connections briefly egress over
 * IPv6, then settle on IPv4. A single retry clears the vast majority of these.
 */
const DFS_RETRYABLE_TASK_CODES = new Set<number>([40207]);
const DFS_MAX_ATTEMPTS = 2;

/**
 * Shape of a single local_pack item in DFS's parsed SERP response.
 * Loosely typed — DFS occasionally adds fields and we don't want to break.
 */
export type LocalPackItem = {
  type: 'local_pack';
  rank_group?: number;
  rank_absolute?: number;
  title?: string;
  description?: string;
  domain?: string;
  phone?: string;
  url?: string;
  cid?: string;
  rating?: {
    value?: number;
    votes_count?: number;
    rating_max?: number;
  } | null;
  [key: string]: unknown;
};

export type ScanPointResult = {
  point: GridPoint;
  /** 1, 2, or 3 if `targetMatch` matched a local_pack item; null otherwise. */
  rank: number | null;
  /** True iff `targetMatch` was found in the local_pack items. */
  businessFound: boolean;
  /** All local_pack items returned (typically 3). Empty if no local pack. */
  items: LocalPackItem[];
  /** Echo of the raw DFS task object for this point (for debugging). */
  raw: unknown;
  /** Per-task cost reported by DFS, in dollars. */
  costDollars: number;
  error?: string;
};

export type ScanResponse = {
  results: ScanPointResult[];
  /** Total cost summed from per-task `cost` fields, converted to integer cents. */
  dfsCostCents: number;
  /** Sum in dollars (full precision, for logging / verification). */
  dfsCostDollars: number;
  /** Count of points that came back with a non-OK status. */
  failedPoints: number;
};

export type RunLiveScanArgs = {
  keyword: string;
  points: GridPoint[];
  /**
   * Optional matcher used to determine `rank` and `businessFound` for each
   * point. Receives a local_pack item and returns true when it represents
   * the client business. If omitted, ranks are recorded null and only the
   * raw competitor data is captured.
   */
  targetMatch?: (item: LocalPackItem) => boolean;
  /** Defaults to 'en'. */
  languageCode?: string;
  device?: 'desktop' | 'mobile';
};

function getAuthHeader(): string {
  const login = process.env.DFS_LOGIN;
  const password = process.env.DFS_PASSWORD;
  if (!login || !password) {
    throw new Error(
      'DFS_LOGIN and DFS_PASSWORD must be set in env (see .env.local).'
    );
  }
  const token = Buffer.from(`${login}:${password}`).toString('base64');
  return `Basic ${token}`;
}

/** POST one task to DFS Live Advanced. Returns the single task object. */
async function postSingleTask(
  task: Record<string, unknown>
): Promise<DfsTask> {
  const res = await fetch(`${DFS_BASE_URL}${DFS_LIVE_ADVANCED}`, {
    method: 'POST',
    headers: {
      Authorization: getAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([task]),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`DFS HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as DfsResponse;
  if (json.status_code !== 20000) {
    throw new Error(
      `DFS gateway error ${json.status_code}: ${json.status_message ?? 'unknown'}`
    );
  }
  if (!json.tasks?.[0]) {
    throw new Error('DFS returned no tasks in response');
  }
  return json.tasks[0];
}

/**
 * Process `items` with at most `limit` callbacks in flight at any time.
 * Returns results in input order; rejections become the result for that slot.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>
): Promise<Array<R | Error>> {
  const out: Array<R | Error> = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];

  const runOne = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        out[i] = e instanceof Error ? e : new Error(String(e));
      }
    }
  };

  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(runOne());
  }
  await Promise.all(workers);
  return out;
}

/**
 * Run a Live local-pack scan across an array of grid points. Each point
 * becomes one DFS task (single-task POSTs run with bounded concurrency).
 *
 * Per-point failures are captured in the result with `error` set; they do
 * NOT abort the whole scan.
 */
export async function runLiveLocalPackScan(
  args: RunLiveScanArgs
): Promise<ScanResponse> {
  const {
    keyword,
    points,
    targetMatch,
    languageCode = 'en',
    device = 'desktop',
  } = args;

  if (!keyword) throw new Error('keyword is required');
  if (!points.length) throw new Error('points is empty');

  const taskResults = await mapWithConcurrency(
    points,
    DFS_CONCURRENCY,
    async (point) => {
      const body = {
        keyword,
        location_coordinate: `${point.lat},${point.lng},${DFS_QUERY_RADIUS_KM}`,
        language_code: languageCode,
        device,
        tag: `${point.x},${point.y}`,
      };
      let lastTask: DfsTask | null = null;
      for (let attempt = 1; attempt <= DFS_MAX_ATTEMPTS; attempt++) {
        const task = await postSingleTask(body);
        lastTask = task;
        if (task.status_code === 20000) return task;
        if (!DFS_RETRYABLE_TASK_CODES.has(task.status_code)) return task;
        if (attempt < DFS_MAX_ATTEMPTS) {
          // brief jittered backoff so concurrent retries don't stampede
          await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
        }
      }
      return lastTask!;
    }
  );

  let totalCostDollars = 0;
  let failedPoints = 0;
  const results: ScanPointResult[] = points.map((point, i) => {
    const task = taskResults[i];

    if (task instanceof Error) {
      failedPoints++;
      return {
        point,
        rank: null,
        businessFound: false,
        items: [],
        raw: null,
        costDollars: 0,
        error: task.message,
      };
    }

    totalCostDollars += task.cost ?? 0;

    if (task.status_code !== 20000) {
      failedPoints++;
      return {
        point,
        rank: null,
        businessFound: false,
        items: [],
        raw: task,
        costDollars: task.cost ?? 0,
        error: `DFS task error ${task.status_code}: ${task.status_message ?? ''}`,
      };
    }

    const allItems = (task.result?.[0]?.items ?? []) as Array<
      Record<string, unknown>
    >;
    const localPack = allItems.filter(
      (it) => it.type === 'local_pack'
    ) as LocalPackItem[];

    let rank: number | null = null;
    let businessFound = false;
    if (targetMatch) {
      const match = localPack.find(targetMatch);
      if (match) {
        businessFound = true;
        rank = (match.rank_group ?? match.rank_absolute ?? null) as
          | number
          | null;
      }
    }

    return {
      point,
      rank,
      businessFound,
      items: localPack,
      raw: task,
      costDollars: task.cost ?? 0,
    };
  });

  return {
    results,
    dfsCostDollars: totalCostDollars,
    dfsCostCents: Math.round(totalCostDollars * 100),
    failedPoints,
  };
}

// ─── Internal DFS response types ───────────────────────────────────────────

type DfsResponse = {
  status_code: number;
  status_message?: string;
  cost?: number;
  tasks?: DfsTask[];
};

type DfsTask = {
  id: string;
  status_code: number;
  status_message?: string;
  cost?: number;
  data?: Record<string, unknown>;
  result?: Array<{
    keyword?: string;
    items?: unknown[];
    items_count?: number;
    [k: string]: unknown;
  }>;
};
