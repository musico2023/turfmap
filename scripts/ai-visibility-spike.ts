/**
 * AI Visibility — Phase 0 validation spike.
 *
 * Evaluates whether "where inside the service area does AI recommend you"
 * is a measurable thing before any product code gets written. Runs a
 * configurable matrix of
 *
 *     engines × grid cells × prompt variants × repetitions
 *
 * through DataForSEO's AI Optimization + SERP endpoints, detects whether
 * the target business is named in each answer, and writes CSVs plus a
 * summary that answers the three Phase 0 questions from the concept memo:
 *
 *   1. Does mention rate vary across grid cells more than it varies
 *      across repetitions of the same cell?        → between/within ratio
 *   2. What does a scan really cost?                → provider-reported cost
 *   3. How noisy is k=5? Do we need k=10?           → Wilson interval widths
 *
 * Spike-only: adapters live in this file, not in lib/dataforseo/client.ts.
 * Phase 1 moves them behind the client module like every other DFS call.
 * See docs/ai-visibility/DEV_EVALUATION.md for the design and cost model.
 *
 * Usage:
 *   npx tsx scripts/ai-visibility-spike.ts --dry-run            # no spend, fake engine
 *   npx tsx scripts/ai-visibility-spike.ts --estimate           # print cost projection only
 *   npx tsx scripts/ai-visibility-spike.ts \
 *     --client "Mr. Rooter Plumbing of Toronto" --domain mrrooter.ca \
 *     --lat 43.6532 --lng -79.3832 --radius 1.6 --grid 3 \
 *     --vertical plumber --city Toronto --region Ontario --country CA \
 *     --engines ai_mode,chatgpt_scraper,perplexity --reps 5 [--extract]
 *
 * Env: DFS_LOGIN, DFS_PASSWORD (required for live runs);
 *      ANTHROPIC_API_KEY (only with --extract).
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { generateGridCoordinates, type GridPoint } from '../lib/dataforseo/grid';
import { nameMatches, normalizeName } from '../lib/citations/napCompare';
import { cleanCompetitorName } from '../lib/dataforseo/cleanCompetitorName';

// ─── Types ─────────────────────────────────────────────────────────────────

type EngineId =
  | 'ai_mode'
  | 'chatgpt_scraper'
  | 'chatgpt_api'
  | 'perplexity'
  | 'gemini_scraper'
  | 'fake';

/** How the engine is told where the "user" is. Reported per run so the
 *  variance analysis can be read per targeting class. */
type LocationMode = 'coordinates' | 'city' | 'country' | 'none';

type Citation = { url: string; domain: string; title: string | null };

type EngineResponse = {
  answerText: string;
  citations: Citation[];
  /** Business names the provider itself extracted (ChatGPT scraper
   *  returns brand_entities + a local-businesses block). Empty for
   *  engines that return free text only. */
  structuredBusinesses: string[];
  modelName: string | null;
  latencyMs: number;
  /** DFS-billed cost for the task (tasks[].cost). */
  costDollars: number;
  /** Third-party LLM pass-through reported by DFS (result[].money_spent),
   *  null where the endpoint has no such field. Phase 0 checks whether
   *  this is already inside costDollars by diffing account balance. */
  moneySpentDollars: number | null;
  raw: unknown;
  error?: string;
};

type PromptVariant = { id: string; template: string };

type Cell = GridPoint & { label: string };

type RunRow = {
  engine: EngineId;
  locationMode: LocationMode;
  cell: Cell;
  prompt: PromptVariant;
  promptText: string;
  rep: number;
  response: EngineResponse;
  targetMentioned: boolean;
  /** Which detector fired: name window, cited domain, provider entity. */
  targetSignal: string;
  ordinal: number | null;
};

type Config = {
  client: string;
  /** Additional names the business trades under (GBP display name etc). */
  aliases: string[];
  domain: string | null;
  lat: number;
  lng: number;
  radiusMiles: number;
  gridSize: number;
  vertical: string;
  city: string;
  region: string;
  /** ISO-3166-1 alpha-2, e.g. CA / US. */
  country: string;
  /** DFS location_name for city-level engines: "City,Region,Country". */
  locationName: string;
  engines: EngineId[];
  reps: number;
  concurrency: number;
  extract: boolean;
  dryRun: boolean;
  estimate: boolean;
  outDir: string;
};

// ─── Constants ─────────────────────────────────────────────────────────────

const DFS_BASE_URL = 'https://api.dataforseo.com';
const ADAPTER_VERSION = 'spike-v1';

const ENGINE_LOCATION_MODE: Record<EngineId, LocationMode> = {
  ai_mode: 'coordinates',
  chatgpt_scraper: 'city',
  gemini_scraper: 'city',
  chatgpt_api: 'city',
  perplexity: 'country',
  fake: 'coordinates',
};

/** List prices in USD per call, used only by --estimate and for the
 *  "what did we expect vs pay" line. Sources: DEV_EVALUATION.md §2. */
const UNIT_COST_USD: Record<EngineId, number> = {
  ai_mode: 0.004, // live; standard queue ~0.0012
  chatgpt_scraper: 0.004, // live; standard queue 0.0012
  gemini_scraper: 0.004,
  chatgpt_api: 0.015, // 0.0006 + gpt-4.1-mini web_search pass-through
  perplexity: 0.007, // 0.0006 + sonar low-context pass-through
  fake: 0,
};
const EXTRACT_COST_PER_CELL_PROMPT_USD = 0.008;

/** Claude Haiku 4.5 list price, USD per token. */
const HAIKU_IN_PER_TOKEN = 1 / 1_000_000;
const HAIKU_OUT_PER_TOKEN = 5 / 1_000_000;
const EXTRACT_MODEL = 'claude-haiku-4-5';

/** The three prompt shapes the product would ship. {vertical} and
 *  {place} are substituted per cell. */
const PROMPTS: PromptVariant[] = [
  {
    id: 'recommend',
    template:
      'Who are the best {vertical}s in {place}? Give me a short list of specific companies.',
  },
  {
    id: 'emergency',
    template:
      'I need an emergency {vertical} in {place} right now. Which companies should I call?',
  },
  {
    id: 'reviews',
    template:
      'Which {vertical} companies in {place} have the best reviews?',
  },
];

/** Tokens either side of a name match that must contain the whole
 *  canonical name. Keeps "Toronto ... plumbing" 40 tokens apart from
 *  counting as "Toronto Plumbing". */
const NAME_WINDOW_TOKENS = 12;

// ─── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Config {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }
  const str = (k: string, d: string) => {
    const v = flags.get(k);
    return typeof v === 'string' ? v : d;
  };
  const num = (k: string, d: number) => {
    const v = flags.get(k);
    if (typeof v !== 'string') return d;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${k} must be a number`);
    return n;
  };
  const bool = (k: string) => flags.has(k);

  const dryRun = bool('dry-run');
  const city = str('city', 'Toronto');
  const region = str('region', 'Ontario');
  const country = str('country', 'CA').toUpperCase();
  const engines = (dryRun
    ? ['fake']
    : str('engines', 'ai_mode,chatgpt_scraper,perplexity').split(',')
  ).map((e) => e.trim()) as EngineId[];
  for (const e of engines) {
    if (!(e in ENGINE_LOCATION_MODE)) {
      throw new Error(
        `unknown engine "${e}" (valid: ${Object.keys(ENGINE_LOCATION_MODE).join(', ')})`
      );
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    client: str('client', 'Mr. Rooter Plumbing of Toronto'),
    aliases: str('aliases', '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean),
    domain: str('domain', 'mrrooter.ca') || null,
    lat: num('lat', 43.6532),
    lng: num('lng', -79.3832),
    radiusMiles: num('radius', 1.6),
    gridSize: num('grid', 3),
    vertical: str('vertical', 'plumber'),
    city,
    region,
    country,
    locationName: str('location-name', `${city},${region},${countryName(country)}`),
    engines,
    reps: num('reps', 5),
    concurrency: num('concurrency', 3),
    extract: bool('extract'),
    dryRun,
    estimate: bool('estimate'),
    outDir: str('out', path.resolve(process.cwd(), 'spike-output', stamp)),
  };
}

function countryName(iso2: string): string {
  const map: Record<string, string> = {
    CA: 'Canada',
    US: 'United States',
    GB: 'United Kingdom',
    AU: 'Australia',
  };
  return map[iso2] ?? iso2;
}

// ─── DFS transport ─────────────────────────────────────────────────────────

type DfsTask = {
  id?: string;
  status_code: number;
  status_message?: string;
  cost?: number;
  result?: Array<Record<string, unknown>> | null;
};

function dfsAuthHeader(): string {
  const login = process.env.DFS_LOGIN;
  const password = process.env.DFS_PASSWORD;
  if (!login || !password) {
    throw new Error('DFS_LOGIN / DFS_PASSWORD missing (set them in .env.local)');
  }
  return 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
}

async function dfsPost(
  endpoint: string,
  task: Record<string, unknown>
): Promise<DfsTask> {
  const res = await fetch(`${DFS_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: dfsAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([task]),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`DFS HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    status_code: number;
    status_message?: string;
    tasks?: DfsTask[];
  };
  if (json.status_code !== 20000) {
    throw new Error(`DFS gateway ${json.status_code}: ${json.status_message ?? ''}`);
  }
  const t = json.tasks?.[0];
  if (!t) throw new Error('DFS returned no task');
  return t;
}

/** Account balance in USD, so the run can report what DFS actually took
 *  rather than what the per-task cost fields claim. */
async function dfsBalance(): Promise<number | null> {
  try {
    const res = await fetch(`${DFS_BASE_URL}/v3/appendix/user_data`, {
      headers: { Authorization: dfsAuthHeader() },
    });
    const json = (await res.json()) as {
      tasks?: Array<{ result?: Array<{ money?: { balance?: number } }> }>;
    };
    const bal = json.tasks?.[0]?.result?.[0]?.money?.balance;
    return typeof bal === 'number' ? bal : null;
  } catch {
    return null;
  }
}

// ─── Generic response walkers ──────────────────────────────────────────────
// DFS shapes differ per endpoint and drift over time. Each adapter reads
// the documented path first and falls back to these walkers so a shape
// change degrades to "less structured", not "empty".

function walk(node: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(node)) {
    for (const v of node) walk(v, visit);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      visit(k, v);
      walk(v, visit);
    }
  }
}

function collectUrls(node: unknown): Citation[] {
  const out = new Map<string, Citation>();
  walk(node, (key, value) => {
    if (key !== 'url' || typeof value !== 'string') return;
    if (!/^https?:\/\//i.test(value)) return;
    const domain = hostOf(value);
    if (!domain || out.has(value)) return;
    out.set(value, { url: value, domain, title: null });
  });
  return [...out.values()];
}

function collectText(node: unknown, keys: string[]): string {
  const parts: string[] = [];
  walk(node, (key, value) => {
    if (keys.includes(key) && typeof value === 'string' && value.trim()) {
      parts.push(value.trim());
    }
  });
  // De-dupe: `markdown` on a parent often repeats children's `text`.
  const seen = new Set<string>();
  return parts
    .filter((p) => {
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    })
    .join('\n');
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

function refsToCitations(refs: unknown): Citation[] {
  if (!Array.isArray(refs)) return [];
  const out: Citation[] = [];
  for (const r of refs as Array<Record<string, unknown>>) {
    const url = typeof r.url === 'string' ? r.url : null;
    if (!url) continue;
    const domain =
      (typeof r.domain === 'string' && r.domain.replace(/^www\./i, '')) ||
      hostOf(url);
    if (!domain) continue;
    out.push({
      url,
      domain: domain.toLowerCase(),
      title: typeof r.title === 'string' ? r.title : null,
    });
  }
  return out;
}

function taskError(task: DfsTask): string | undefined {
  return task.status_code === 20000
    ? undefined
    : `DFS task ${task.status_code}: ${task.status_message ?? ''}`;
}

// ─── Engine adapters ───────────────────────────────────────────────────────

type AdapterInput = { prompt: string; cell: Cell; cfg: Config };
type Adapter = (input: AdapterInput) => Promise<EngineResponse>;

/** Google AI Mode. Coordinate-targeted: location_coordinate here is
 *  "lat,lng,ZOOMz" (4z-18z), unlike the organic endpoint's radius form. */
const aiModeAdapter: Adapter = async ({ prompt, cell }) => {
  const t0 = Date.now();
  const task = await dfsPost('/v3/serp/google/ai_mode/live/advanced', {
    keyword: prompt,
    location_coordinate: `${cell.lat},${cell.lng},15z`,
    language_code: 'en',
    device: 'desktop',
    tag: `${cell.x},${cell.y}`,
  });
  const result = task.result?.[0] ?? {};
  const items = (result.items ?? []) as Array<Record<string, unknown>>;
  const overview = items.find((it) => it.type === 'ai_overview');
  const answerText =
    (typeof overview?.markdown === 'string' && overview.markdown) ||
    collectText(items, ['markdown', 'text']);
  const citations = overview
    ? [
        ...refsToCitations(overview.references),
        ...refsToCitations(
          ((overview.items ?? []) as Array<Record<string, unknown>>).flatMap(
            (it) => (Array.isArray(it.references) ? it.references : [])
          )
        ),
      ]
    : collectUrls(items);
  return {
    answerText,
    citations: dedupeCitations(citations),
    structuredBusinesses: [],
    modelName: 'google-ai-mode',
    latencyMs: Date.now() - t0,
    costDollars: task.cost ?? 0,
    moneySpentDollars: null,
    raw: task,
    error: taskError(task),
  };
};

/** ChatGPT / Gemini consumer-UI scrapers. City-level location via the
 *  DFS location DB. Returns markdown + cited sources + brand_entities. */
function scraperAdapter(platform: 'chat_gpt' | 'gemini'): Adapter {
  return async ({ prompt, cell, cfg }) => {
    const t0 = Date.now();
    const task = await dfsPost(
      `/v3/ai_optimization/${platform}/llm_scraper/live/advanced`,
      {
        keyword: prompt,
        location_name: cfg.locationName,
        language_code: 'en',
        tag: `${cell.x},${cell.y}`,
      }
    );
    const result = task.result?.[0] ?? {};
    const answerText =
      (typeof result.markdown === 'string' && result.markdown) ||
      collectText(result.items, ['markdown', 'text']);
    const citations = dedupeCitations([
      ...refsToCitations(result.sources),
      ...collectUrls(result.items),
    ]);
    const structured = new Set<string>();
    walk(result, (key, value) => {
      if (key === 'brand_entities' && Array.isArray(value)) {
        for (const b of value) {
          if (typeof b === 'string') structured.add(b);
          else if (b && typeof b === 'object') {
            const name = (b as Record<string, unknown>).name;
            if (typeof name === 'string') structured.add(name);
          }
        }
      }
    });
    const items = (result.items ?? []) as Array<Record<string, unknown>>;
    for (const it of items) {
      if (it.type !== `${platform}_local_businesses`) continue;
      for (const b of (it.items ?? []) as Array<Record<string, unknown>>) {
        const name = b.title ?? b.name;
        if (typeof name === 'string') structured.add(name);
      }
    }
    return {
      answerText,
      citations,
      structuredBusinesses: [...structured].map(cleanCompetitorName).filter(Boolean),
      modelName: typeof result.model === 'string' ? result.model : platform,
      latencyMs: Date.now() - t0,
      costDollars: task.cost ?? 0,
      moneySpentDollars: null,
      raw: task,
      error: taskError(task),
    };
  };
}

/** LLM Responses (API route). ChatGPT takes country + city for web
 *  search; Perplexity takes country only and always searches. */
function llmResponsesAdapter(
  platform: 'chat_gpt' | 'perplexity',
  modelName: string
): Adapter {
  return async ({ prompt, cell, cfg }) => {
    const t0 = Date.now();
    const body: Record<string, unknown> = {
      user_prompt: prompt,
      model_name: modelName,
      max_output_tokens: 1024,
      web_search_country_iso_code: cfg.country,
      tag: `${cell.x},${cell.y}`,
    };
    if (platform === 'chat_gpt') {
      body.web_search = true;
      body.web_search_city = cfg.city;
    }
    const task = await dfsPost(
      `/v3/ai_optimization/${platform}/llm_responses/live`,
      body
    );
    const result = task.result?.[0] ?? {};
    const items = (result.items ?? []) as Array<Record<string, unknown>>;
    const texts: string[] = [];
    const citations: Citation[] = [];
    for (const it of items) {
      if (it.type && it.type !== 'message') continue;
      for (const s of (it.sections ?? []) as Array<Record<string, unknown>>) {
        if (typeof s.text === 'string') texts.push(s.text);
        citations.push(...refsToCitations(s.annotations));
      }
    }
    const answerText = texts.join('\n') || collectText(items, ['text']);
    return {
      answerText,
      citations: dedupeCitations(citations.length ? citations : collectUrls(items)),
      structuredBusinesses: [],
      modelName: typeof result.model_name === 'string' ? result.model_name : modelName,
      latencyMs: Date.now() - t0,
      costDollars: task.cost ?? 0,
      moneySpentDollars:
        typeof result.money_spent === 'number' ? result.money_spent : null,
      raw: task,
      error: taskError(task),
    };
  };
}

/**
 * Dry-run engine. Deterministic pseudo-random answers with a built-in
 * geographic effect (the target is named more often in the north-west of
 * the grid) so the analysis code can be checked end to end for free. A
 * real run should NOT look this clean.
 */
const fakeAdapter: Adapter = async ({ prompt, cell, cfg }) => {
  const seed = hash(`${prompt}|${cell.x}|${cell.y}|${Math.random()}`);
  const rnd = mulberry32(seed);
  const geoBias = (cfg.gridSize - 1 - cell.x + (cfg.gridSize - 1 - cell.y)) /
    (2 * (cfg.gridSize - 1) || 1);
  const pMention = 0.15 + 0.7 * geoBias;
  const competitors = ['Acme Drain Co', 'Northside Plumbing', 'Rapid Rooter', 'Blue Pipe Services'];
  const list: string[] = [];
  const cited: Citation[] = [];
  const mention = rnd() < pMention;
  const n = 3 + Math.floor(rnd() * 2);
  const pool = competitors.slice().sort(() => rnd() - 0.5);
  for (let i = 0; i < n; i++) list.push(pool[i % pool.length]);
  if (mention) {
    list.splice(Math.floor(rnd() * list.length), 0, cfg.client);
    if (cfg.domain) cited.push({ url: `https://${cfg.domain}/`, domain: cfg.domain, title: cfg.client });
  }
  cited.push({ url: 'https://www.yelp.ca/search?q=plumber', domain: 'yelp.ca', title: 'Yelp' });
  cited.push({ url: 'https://www.homestars.com/plumbers', domain: 'homestars.com', title: 'HomeStars' });
  const answerText =
    `Here are some well-regarded options in ${cell.label}:\n` +
    list.map((name, i) => `${i + 1}. ${name} - highly rated locally.`).join('\n');
  await new Promise((r) => setTimeout(r, 5));
  return {
    answerText,
    citations: cited,
    structuredBusinesses: [],
    modelName: 'fake-1',
    latencyMs: 5,
    costDollars: 0,
    moneySpentDollars: null,
    raw: null,
  };
};

const ADAPTERS: Record<EngineId, Adapter> = {
  ai_mode: aiModeAdapter,
  chatgpt_scraper: scraperAdapter('chat_gpt'),
  gemini_scraper: scraperAdapter('gemini'),
  chatgpt_api: llmResponsesAdapter('chat_gpt', 'gpt-4.1-mini'),
  perplexity: llmResponsesAdapter('perplexity', 'sonar'),
  fake: fakeAdapter,
};

function dedupeCitations(list: Citation[]): Citation[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}

// ─── Target detection ──────────────────────────────────────────────────────

/**
 * Windowed name match: the canonical name's tokens must all sit inside a
 * NAME_WINDOW_TOKENS-wide window of the answer. Delegates the actual
 * comparison to nameMatches so the spike uses the exact matcher the
 * product already trusts for local-pack titles and directory listings.
 */
function nameInText(canonical: string, text: string): boolean {
  const tokens = normalizeName(text).split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  const canonLen = Math.max(1, normalizeName(canonical).split(/\s+/).filter(Boolean).length);
  const width = Math.max(NAME_WINDOW_TOKENS, canonLen + 2);
  for (let i = 0; i <= Math.max(0, tokens.length - 1); i += 1) {
    const window = tokens.slice(i, i + width).join(' ');
    if (nameMatches(canonical, window)) return true;
    if (i + width >= tokens.length) break;
  }
  return false;
}

function detectTarget(
  cfg: Config,
  r: EngineResponse
): { mentioned: boolean; signal: string; ordinal: number | null } {
  const names = [cfg.client, ...cfg.aliases];
  const signals: string[] = [];

  if (names.some((n) => nameInText(n, r.answerText))) signals.push('name');
  if (
    cfg.domain &&
    r.citations.some(
      (c) => c.domain === cfg.domain!.replace(/^www\./i, '').toLowerCase() ||
        c.domain.endsWith('.' + cfg.domain!.replace(/^www\./i, '').toLowerCase())
    )
  ) {
    signals.push('domain');
  }
  if (r.structuredBusinesses.some((b) => names.some((n) => nameMatches(n, b)))) {
    signals.push('entity');
  }

  // Ordinal: position among list-shaped lines in which the name appears.
  let ordinal: number | null = null;
  if (signals.includes('name')) {
    const listLines = r.answerText
      .split(/\r?\n/)
      .filter((l) => /^\s*(\d+[.)]|[-*•]|\*\*)/.test(l));
    const idx = listLines.findIndex((l) => names.some((n) => nameInText(n, l)));
    if (idx >= 0) ordinal = idx + 1;
  }
  return { mentioned: signals.length > 0, signal: signals.join('+') || '', ordinal };
}

// ─── Optional LLM competitor extraction (Claude Haiku, strict schema) ─────

type Extracted = { name: string; ordinal: number | null };

async function extractBusinesses(
  answers: string[],
  cfg: Config
): Promise<{ perAnswer: Extracted[][]; costDollars: number }> {
  const [{ default: Anthropic }, { zodOutputFormat }, { z }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('@anthropic-ai/sdk/helpers/zod'),
    import('zod'),
  ]);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing (needed for --extract)');
  const client = new Anthropic({ apiKey });
  const Schema = z.object({
    answers: z.array(
      z.object({
        index: z.number(),
        businesses: z.array(
          z.object({
            name: z.string(),
            ordinal: z.number().nullable(),
            is_local_service_business: z.boolean(),
          })
        ),
      })
    ),
  });
  const numbered = answers
    .map((a, i) => `<answer index="${i}">\n${a.slice(0, 4000)}\n</answer>`)
    .join('\n\n');
  const msg = await client.messages.parse({
    model: EXTRACT_MODEL,
    max_tokens: 2000,
    temperature: 0,
    system:
      `You extract business names from AI assistant answers about ${cfg.vertical} services in ${cfg.city}. ` +
      'List every named company exactly as written. ordinal = its position in the answer\'s recommendation order, ' +
      'or null if the answer is not a list. is_local_service_business is false for directories, ' +
      'review sites, franchisor brands without a location, and generic terms.',
    messages: [{ role: 'user', content: numbered }],
    output_config: { format: zodOutputFormat(Schema) },
  });
  const usage = msg.usage;
  const costDollars =
    (usage?.input_tokens ?? 0) * HAIKU_IN_PER_TOKEN +
    (usage?.output_tokens ?? 0) * HAIKU_OUT_PER_TOKEN;
  const perAnswer: Extracted[][] = answers.map(() => []);
  for (const a of msg.parsed_output?.answers ?? []) {
    if (a.index < 0 || a.index >= answers.length) continue;
    perAnswer[a.index] = a.businesses
      .filter((b) => b.is_local_service_business)
      .map((b) => ({ name: cleanCompetitorName(b.name), ordinal: b.ordinal }))
      .filter((b) => b.name);
  }
  return { perAnswer, costDollars };
}

// ─── Cell labels (reverse geocode) ─────────────────────────────────────────

async function labelCells(points: GridPoint[], cfg: Config): Promise<Cell[]> {
  const cells: Cell[] = [];
  for (const p of points) {
    let label = `${cfg.city}`;
    if (!cfg.dryRun) {
      const hood = await reverseGeocodeNeighbourhood(p.lat, p.lng);
      if (hood && hood.toLowerCase() !== cfg.city.toLowerCase()) {
        label = `${hood}, ${cfg.city}`;
      }
      // Nominatim policy: max 1 req/s.
      await new Promise((r) => setTimeout(r, 1100));
    } else {
      label = `Cell ${p.x},${p.y}, ${cfg.city}`;
    }
    cells.push({ ...p, label });
  }
  return cells;
}

async function reverseGeocodeNeighbourhood(lat: number, lng: number): Promise<string | null> {
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14` +
      `&lat=${lat}&lon=${lng}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'TurfMap.ai/1.0 (https://turfmap.ai; anthony@fourdots.io)',
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { address?: Record<string, string> };
    const a = json.address ?? {};
    return (
      a.neighbourhood ?? a.suburb ?? a.quarter ?? a.city_district ?? a.borough ??
      a.town ?? a.village ?? null
    );
  } catch {
    return null;
  }
}

// ─── Stats ─────────────────────────────────────────────────────────────────

function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - half) / denom), Math.min(1, (centre + half) / denom)];
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}

// ─── Aggregation ───────────────────────────────────────────────────────────

type CellAgg = {
  engine: EngineId;
  x: number;
  y: number;
  label: string;
  runs: number;
  failed: number;
  mentions: number;
  mentionRate: number;
  ci: [number, number];
  avgOrdinal: number | null;
  competitorCounts: Map<string, number>;
  citationDomains: Map<string, number>;
  costDollars: number;
};

function aggregateCells(rows: RunRow[], extracted: Map<RunRow, Extracted[]>): CellAgg[] {
  const byKey = new Map<string, CellAgg>();
  for (const r of rows) {
    const key = `${r.engine}|${r.cell.x}|${r.cell.y}`;
    let agg = byKey.get(key);
    if (!agg) {
      agg = {
        engine: r.engine,
        x: r.cell.x,
        y: r.cell.y,
        label: r.cell.label,
        runs: 0,
        failed: 0,
        mentions: 0,
        mentionRate: 0,
        ci: [0, 1],
        avgOrdinal: null,
        competitorCounts: new Map(),
        citationDomains: new Map(),
        costDollars: 0,
      };
      byKey.set(key, agg);
    }
    agg.costDollars += r.response.costDollars;
    if (r.response.error) {
      agg.failed++;
      continue;
    }
    agg.runs++;
    if (r.targetMentioned) agg.mentions++;
    for (const c of r.response.citations) {
      agg.citationDomains.set(c.domain, (agg.citationDomains.get(c.domain) ?? 0) + 1);
    }
    const names = new Set<string>([
      ...r.response.structuredBusinesses,
      ...(extracted.get(r) ?? []).map((e) => e.name),
    ]);
    for (const n of names) {
      agg.competitorCounts.set(n, (agg.competitorCounts.get(n) ?? 0) + 1);
    }
  }
  const ordinals = new Map<string, number[]>();
  for (const r of rows) {
    if (r.ordinal == null) continue;
    const key = `${r.engine}|${r.cell.x}|${r.cell.y}`;
    ordinals.set(key, [...(ordinals.get(key) ?? []), r.ordinal]);
  }
  for (const [key, agg] of byKey) {
    agg.mentionRate = agg.runs ? agg.mentions / agg.runs : 0;
    agg.ci = wilson(agg.mentions, agg.runs);
    const o = ordinals.get(key);
    agg.avgOrdinal = o && o.length ? Math.round(mean(o) * 10) / 10 : null;
  }
  return [...byKey.values()];
}

type EngineVerdict = {
  engine: EngineId;
  locationMode: LocationMode;
  cells: number;
  runsPerCell: number;
  meanRate: number;
  betweenVar: number;
  withinVar: number;
  ratio: number;
  ciWidthAtK: number;
  ciWidthAt2K: number;
  costDollars: number;
  moneySpentDollars: number;
  failed: number;
};

function judgeEngines(cells: CellAgg[], rows: RunRow[]): EngineVerdict[] {
  const engines = [...new Set(cells.map((c) => c.engine))];
  return engines.map((engine) => {
    const mine = cells.filter((c) => c.engine === engine && c.runs > 0);
    const rates = mine.map((c) => c.mentionRate);
    const p = mean(rates);
    const n = Math.round(mean(mine.map((c) => c.runs))) || 1;
    // Expected sampling variance of a per-cell rate if every cell shared
    // the same true rate: binomial p(1-p)/n. If the observed between-cell
    // variance is not clearly above this, "geography" is just noise.
    const withinVar = (p * (1 - p)) / n;
    const betweenVar = variance(rates);
    const ratio = withinVar > 0 ? betweenVar / withinVar : betweenVar > 0 ? Infinity : 0;
    const [lo, hi] = wilson(Math.round(p * n), n);
    const [lo2, hi2] = wilson(Math.round(p * 2 * n), 2 * n);
    const engineRows = rows.filter((r) => r.engine === engine);
    return {
      engine,
      locationMode: ENGINE_LOCATION_MODE[engine],
      cells: mine.length,
      runsPerCell: n,
      meanRate: p,
      betweenVar,
      withinVar,
      ratio,
      ciWidthAtK: hi - lo,
      ciWidthAt2K: hi2 - lo2,
      costDollars: engineRows.reduce((a, r) => a + r.response.costDollars, 0),
      moneySpentDollars: engineRows.reduce(
        (a, r) => a + (r.response.moneySpentDollars ?? 0),
        0
      ),
      failed: engineRows.filter((r) => r.response.error).length,
    };
  });
}

// ─── Output ────────────────────────────────────────────────────────────────

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
function usd(x: number): string {
  return `$${x.toFixed(4)}`;
}

function writeOutputs(
  cfg: Config,
  rows: RunRow[],
  cells: CellAgg[],
  verdicts: EngineVerdict[],
  extracted: Map<RunRow, Extracted[]>,
  extras: { extractionCost: number; balanceBefore: number | null; balanceAfter: number | null }
): void {
  fs.mkdirSync(cfg.outDir, { recursive: true });

  fs.writeFileSync(
    path.join(cfg.outDir, 'runs.csv'),
    csv([
      [
        'engine', 'location_mode', 'grid_x', 'grid_y', 'lat', 'lng', 'place_label',
        'prompt_id', 'rep', 'model', 'adapter_version', 'latency_ms', 'cost_usd',
        'money_spent_usd', 'error', 'target_mentioned', 'target_signal', 'ordinal',
        'n_citations', 'citation_domains', 'businesses', 'answer_excerpt',
      ],
      ...rows.map((r) => [
        r.engine, r.locationMode, r.cell.x, r.cell.y, r.cell.lat, r.cell.lng, r.cell.label,
        r.prompt.id, r.rep, r.response.modelName, ADAPTER_VERSION, r.response.latencyMs,
        r.response.costDollars, r.response.moneySpentDollars ?? '', r.response.error ?? '',
        r.targetMentioned ? 1 : 0, r.targetSignal, r.ordinal ?? '',
        r.response.citations.length,
        [...new Set(r.response.citations.map((c) => c.domain))].join('|'),
        [...new Set([
          ...r.response.structuredBusinesses,
          ...(extracted.get(r) ?? []).map((e) => e.name),
        ])].join('|'),
        r.response.answerText.replace(/\s+/g, ' ').slice(0, 240),
      ]),
    ])
  );

  // Full answers for hand-labelling: one JSON object per line.
  fs.writeFileSync(
    path.join(cfg.outDir, 'answers.jsonl'),
    rows
      .map((r) =>
        JSON.stringify({
          engine: r.engine,
          cell: [r.cell.x, r.cell.y],
          place: r.cell.label,
          prompt_id: r.prompt.id,
          prompt: r.promptText,
          rep: r.rep,
          target_mentioned: r.targetMentioned,
          target_signal: r.targetSignal,
          answer: r.response.answerText,
          citations: r.response.citations,
          label_target_mentioned: null,
          label_businesses: null,
        })
      )
      .join('\n') + '\n'
  );

  fs.writeFileSync(
    path.join(cfg.outDir, 'raw.jsonl'),
    rows
      .filter((r) => r.response.raw != null)
      .map((r) => JSON.stringify({ engine: r.engine, cell: [r.cell.x, r.cell.y], prompt_id: r.prompt.id, rep: r.rep, raw: r.response.raw }))
      .join('\n') + '\n'
  );

  fs.writeFileSync(
    path.join(cfg.outDir, 'cells.csv'),
    csv([
      ['engine', 'grid_x', 'grid_y', 'place_label', 'runs', 'failed', 'mentions',
        'mention_rate', 'ci_low', 'ci_high', 'avg_ordinal', 'top_competitors', 'top_citation_domains', 'cost_usd'],
      ...cells.map((c) => [
        c.engine, c.x, c.y, c.label, c.runs, c.failed, c.mentions,
        c.mentionRate.toFixed(3), c.ci[0].toFixed(3), c.ci[1].toFixed(3), c.avgOrdinal ?? '',
        topN(c.competitorCounts, 5), topN(c.citationDomains, 5), c.costDollars.toFixed(4),
      ]),
    ])
  );

  // Citation mining: the deliverable that sells. Domain × engine counts.
  const domainTotals = new Map<string, Map<EngineId, number>>();
  for (const r of rows) {
    if (r.response.error) continue;
    for (const d of new Set(r.response.citations.map((c) => c.domain))) {
      const m = domainTotals.get(d) ?? new Map<EngineId, number>();
      m.set(r.engine, (m.get(r.engine) ?? 0) + 1);
      domainTotals.set(d, m);
    }
  }
  const engines = [...new Set(rows.map((r) => r.engine))];
  fs.writeFileSync(
    path.join(cfg.outDir, 'citations.csv'),
    csv([
      ['domain', 'total_runs_citing', ...engines.map((e) => `${e}_runs_citing`), 'is_target_domain'],
      ...[...domainTotals.entries()]
        .map(([d, m]) => ({ d, m, total: [...m.values()].reduce((a, b) => a + b, 0) }))
        .sort((a, b) => b.total - a.total)
        .map(({ d, m, total }) => [
          d, total, ...engines.map((e) => m.get(e) ?? 0),
          cfg.domain && (d === cfg.domain || d.endsWith('.' + cfg.domain)) ? 1 : 0,
        ]),
    ])
  );

  const totalCost = rows.reduce((a, r) => a + r.response.costDollars, 0);
  const totalRuns = rows.length;
  const lines: string[] = [];
  lines.push(`# AI Visibility spike — ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`Target: **${cfg.client}** (${cfg.domain ?? 'no domain'}), ${cfg.vertical} in ${cfg.city}. ` +
    `Grid ${cfg.gridSize}×${cfg.gridSize} at ${cfg.radiusMiles} mi radius. ${PROMPTS.length} prompts × k=${cfg.reps}. ` +
    `Engines: ${cfg.engines.join(', ')}. Adapter ${ADAPTER_VERSION}.`);
  lines.push('');
  lines.push('## Question 1: does mention rate vary across cells more than across repetitions?');
  lines.push('');
  lines.push('| engine | location targeting | cells | runs/cell | mean mention rate | between-cell var | within-cell var (binomial) | ratio | verdict |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const v of verdicts) {
    const verdict =
      v.cells < 2 ? 'n/a' :
      v.meanRate === 0 ? 'never mentioned — no signal to vary' :
      v.meanRate === 1 ? 'always mentioned — no signal to vary' :
      v.ratio >= 2 ? 'GEO SIGNAL: between-cell spread is ≥2× sampling noise' :
      v.ratio >= 1.2 ? 'weak: spread barely above noise, re-run at k=10 before deciding' :
      'NO GEO SIGNAL at this k: cells are indistinguishable from repetitions';
    lines.push(`| ${v.engine} | ${v.locationMode} | ${v.cells} | ${v.runsPerCell} | ${pct(v.meanRate)} | ${v.betweenVar.toFixed(4)} | ${v.withinVar.toFixed(4)} | ${Number.isFinite(v.ratio) ? v.ratio.toFixed(2) : '∞'} | ${verdict} |`);
  }
  lines.push('');
  lines.push('Read per targeting class: a coordinate-targeted engine that shows no spread means AI answers are flat across the area; ' +
    'a city-targeted engine that shows spread means the neighbourhood string in the prompt is doing the work.');
  lines.push('');
  lines.push('## Question 2: what did it cost?');
  lines.push('');
  lines.push('| engine | runs | failed | DFS cost (tasks[].cost) | LLM pass-through (money_spent) | per run | list-price expectation |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const v of verdicts) {
    const n = rows.filter((r) => r.engine === v.engine).length;
    lines.push(`| ${v.engine} | ${n} | ${v.failed} | ${usd(v.costDollars)} | ${usd(v.moneySpentDollars)} | ${usd(n ? v.costDollars / n : 0)} | ${usd(UNIT_COST_USD[v.engine])} |`);
  }
  lines.push('');
  lines.push(`Total DFS cost across ${totalRuns} runs: **${usd(totalCost)}**` +
    (cfg.extract ? ` plus **${usd(extras.extractionCost)}** Claude extraction` : '') + '.');
  if (extras.balanceBefore != null && extras.balanceAfter != null) {
    const delta = extras.balanceBefore - extras.balanceAfter;
    lines.push(`DFS account balance moved by **${usd(delta)}** (before ${usd(extras.balanceBefore)}, after ${usd(extras.balanceAfter)}). ` +
      (Math.abs(delta - totalCost) < 0.01
        ? 'Matches the summed task costs, so tasks[].cost is the full charge.'
        : 'Does NOT match summed task costs — check whether money_spent is billed on top.'));
  }
  lines.push('');
  lines.push('Projection at the observed per-run cost (3 prompts, same k, standard queue assumed at 1/3 of live):');
  lines.push('');
  lines.push('| engine | 9 cells | 25 cells | 49 cells |');
  lines.push('|---|---|---|---|');
  for (const v of verdicts) {
    const n = rows.filter((r) => r.engine === v.engine).length || 1;
    const per = v.costDollars / n;
    const std = v.locationMode === 'coordinates' || v.engine.endsWith('_scraper') ? per / 3 : per;
    const f = (c: number) => `$${(std * c * PROMPTS.length * cfg.reps).toFixed(2)}`;
    lines.push(`| ${v.engine} | ${f(9)} | ${f(25)} | ${f(49)} |`);
  }
  lines.push('');
  lines.push('## Question 3: how noisy is k?');
  lines.push('');
  lines.push('| engine | k | 95% interval width at k | width at 2k | usable? |');
  lines.push('|---|---|---|---|---|');
  for (const v of verdicts) {
    const spread = Math.sqrt(Math.max(v.betweenVar, 0)) * 2; // ~ 2 SD across cells
    const usable = spread === 0 ? 'no spread to resolve' : v.ciWidthAtK < spread ? 'yes at k' : v.ciWidthAt2K < spread ? 'needs 2k' : 'neither k nor 2k resolves the observed spread';
    lines.push(`| ${v.engine} | ${v.runsPerCell} | ${pct(v.ciWidthAtK)} | ${pct(v.ciWidthAt2K)} | ${usable} |`);
  }
  lines.push('');
  lines.push('"Usable" compares the interval width to roughly two standard deviations of the between-cell rates: if a single cell\'s interval is wider than the spread between cells, the map is painting noise.');
  lines.push('');
  lines.push('## Citation mining (top 15 domains)');
  lines.push('');
  lines.push('| domain | runs citing | target? |');
  lines.push('|---|---|---|');
  for (const [d, m] of [...domainTotals.entries()]
    .sort((a, b) => sum(b[1]) - sum(a[1]))
    .slice(0, 15)) {
    lines.push(`| ${d} | ${sum(m)} | ${cfg.domain && (d === cfg.domain || d.endsWith('.' + cfg.domain)) ? 'YES' : ''} |`);
  }
  lines.push('');
  lines.push('## Next step');
  lines.push('');
  lines.push('Hand-label `answers.jsonl` (fill `label_target_mentioned` and `label_businesses` on ~150 rows), ' +
    'then compare against `target_mentioned` to get detector precision/recall before trusting any rate above.');
  fs.writeFileSync(path.join(cfg.outDir, 'summary.md'), lines.join('\n') + '\n');
}

function sum(m: Map<EngineId, number>): number {
  return [...m.values()].reduce((a, b) => a + b, 0);
}
function topN(m: Map<string, number>, n: number): string {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} (${v})`)
    .join('|');
}

// ─── Estimate mode ─────────────────────────────────────────────────────────

function printEstimate(cfg: Config): void {
  const cells = cfg.gridSize * cfg.gridSize;
  const runsPerEngine = cells * PROMPTS.length * cfg.reps;
  console.log(`Matrix: ${cfg.gridSize}×${cfg.gridSize} = ${cells} cells × ${PROMPTS.length} prompts × k=${cfg.reps} = ${runsPerEngine} runs per engine`);
  let total = 0;
  for (const e of cfg.engines) {
    const c = runsPerEngine * UNIT_COST_USD[e];
    total += c;
    console.log(`  ${e.padEnd(16)} ${ENGINE_LOCATION_MODE[e].padEnd(12)} ~$${c.toFixed(2)} at list $${UNIT_COST_USD[e]}/call (live)`);
  }
  if (cfg.extract) {
    const c = cells * PROMPTS.length * cfg.engines.length * EXTRACT_COST_PER_CELL_PROMPT_USD;
    total += c;
    console.log(`  ${'extraction'.padEnd(16)} ${''.padEnd(12)} ~$${c.toFixed(2)} (Haiku, batched per cell-prompt)`);
  }
  console.log(`  ${'total'.padEnd(29)} ~$${total.toFixed(2)}  (k=${cfg.reps * 2}: ~$${(total * 2).toFixed(2)})`);
}

// ─── Concurrency helper ────────────────────────────────────────────────────

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ─── Small deterministic RNG for the dry-run engine ───────────────────────

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));

  if (cfg.estimate) {
    printEstimate(cfg);
    return;
  }

  const points = generateGridCoordinates({
    centerLat: cfg.lat,
    centerLng: cfg.lng,
    gridSize: cfg.gridSize,
    radiusMiles: cfg.radiusMiles,
  });
  console.log(`▸ ${cfg.dryRun ? 'DRY RUN — ' : ''}${points.length} cells, ${PROMPTS.length} prompts, k=${cfg.reps}, engines: ${cfg.engines.join(', ')}`);
  printEstimate(cfg);

  console.log('▸ labelling cells (reverse geocode)…');
  const cells = await labelCells(points, cfg);
  for (const c of cells) console.log(`   (${c.x},${c.y}) ${c.lat},${c.lng} → ${c.label}`);

  const jobs: Array<{ engine: EngineId; cell: Cell; prompt: PromptVariant; rep: number }> = [];
  for (const engine of cfg.engines)
    for (const cell of cells)
      for (const prompt of PROMPTS)
        for (let rep = 1; rep <= cfg.reps; rep++) jobs.push({ engine, cell, prompt, rep });

  const balanceBefore = cfg.dryRun ? null : await dfsBalance();
  console.log(`▸ running ${jobs.length} calls at concurrency ${cfg.concurrency}…`);
  let done = 0;
  let spent = 0;
  const t0 = Date.now();
  const rows: RunRow[] = await mapWithConcurrency(jobs, cfg.concurrency, async (job) => {
    const promptText = job.prompt.template
      .replace('{vertical}', cfg.vertical)
      .replace('{place}', job.cell.label);
    let response: EngineResponse;
    try {
      response = await ADAPTERS[job.engine]({ prompt: promptText, cell: job.cell, cfg });
    } catch (e) {
      response = {
        answerText: '',
        citations: [],
        structuredBusinesses: [],
        modelName: null,
        latencyMs: 0,
        costDollars: 0,
        moneySpentDollars: null,
        raw: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    const det = response.error
      ? { mentioned: false, signal: '', ordinal: null }
      : detectTarget(cfg, response);
    done++;
    spent += response.costDollars;
    if (done % 25 === 0 || done === jobs.length) {
      console.log(`   ${done}/${jobs.length} (${((Date.now() - t0) / 1000).toFixed(0)}s, $${spent.toFixed(3)} so far)`);
    }
    return {
      engine: job.engine,
      locationMode: ENGINE_LOCATION_MODE[job.engine],
      cell: job.cell,
      prompt: job.prompt,
      promptText,
      rep: job.rep,
      response,
      targetMentioned: det.mentioned,
      targetSignal: det.signal,
      ordinal: det.ordinal,
    };
  });
  const balanceAfter = cfg.dryRun ? null : await dfsBalance();

  // Optional competitor extraction: one Haiku call per (engine, cell,
  // prompt), batching the k answers so the bill is per cell-prompt, not
  // per run.
  const extracted = new Map<RunRow, Extracted[]>();
  let extractionCost = 0;
  if (cfg.extract) {
    console.log('▸ extracting business names with Claude…');
    const groups = new Map<string, RunRow[]>();
    for (const r of rows) {
      if (r.response.error || !r.response.answerText) continue;
      const key = `${r.engine}|${r.cell.x}|${r.cell.y}|${r.prompt.id}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    await mapWithConcurrency([...groups.values()], 3, async (group) => {
      try {
        const res = await extractBusinesses(group.map((r) => r.response.answerText), cfg);
        extractionCost += res.costDollars;
        group.forEach((r, i) => extracted.set(r, res.perAnswer[i] ?? []));
      } catch (e) {
        console.warn('   extraction failed for a group:', e instanceof Error ? e.message : e);
      }
    });
  }

  const cellAggs = aggregateCells(rows, extracted);
  const verdicts = judgeEngines(cellAggs, rows);
  writeOutputs(cfg, rows, cellAggs, verdicts, extracted, { extractionCost, balanceBefore, balanceAfter });

  console.log('');
  console.log(fs.readFileSync(path.join(cfg.outDir, 'summary.md'), 'utf8'));
  console.log(`▸ wrote runs.csv, cells.csv, citations.csv, answers.jsonl, raw.jsonl, summary.md → ${cfg.outDir}`);
}

main().catch((e) => {
  console.error('✗', e instanceof Error ? e.message : e);
  process.exit(1);
});
