/**
 * GET /api/dev/smoke-test/citation-builder — non-destructive BL
 * Citation Builder probe.
 *
 * Verifies three things before flipping CITATION_BUILDER_ENABLED=true
 * in production, without firing any actual order submissions:
 *
 *   1. BRIGHTLOCAL_API_KEY is set and valid (auth probe against the
 *      known-good audit-side fetch endpoint).
 *   2. /data/v1/citation-builder/orders is reachable from this account
 *      (i.e. Citation Builder product is enabled on the BL plan).
 *   3. Reports the actual HTTP status + response body slice from each
 *      probe so the operator can confirm endpoint paths against BL's
 *      current docs before going live.
 *
 * Agency-gated. Returns a JSON report; never fires a POST that could
 * cost money.
 */

import { NextResponse } from 'next/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';

export const runtime = 'nodejs';
export const maxDuration = 30;

const BL_BASE = 'https://api.brightlocal.com';

type Probe = {
  name: string;
  method: string;
  url: string;
  status: number | null;
  ok: boolean;
  body_excerpt: string | null;
  notes: string;
};

export async function GET() {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;

  const apiKey = process.env.BRIGHTLOCAL_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        ok: false,
        gate: { CITATION_BUILDER_ENABLED: process.env.CITATION_BUILDER_ENABLED ?? null },
        error: 'BRIGHTLOCAL_API_KEY is not set in this environment.',
      },
      { status: 500 }
    );
  }

  const probes: Probe[] = [];

  // Probe 1: known-good audit endpoint. We expect a 4xx because we're
  // not posting a valid payload — but NOT a 401/403. Anything other
  // than auth-rejection means the API key is good.
  probes.push(
    await runProbe({
      name: 'audit-side auth check (POST /data/v1/listings/fetch)',
      method: 'POST',
      url: `${BL_BASE}/data/v1/listings/fetch`,
      apiKey,
      body: JSON.stringify({}),
      contentType: 'application/json',
      notesFromStatus: (s) =>
        s === 401 || s === 403
          ? 'BAD: API key rejected — fix BRIGHTLOCAL_API_KEY before going further.'
          : s != null && s >= 400 && s < 500
            ? 'OK: 4xx with auth header accepted. API key is valid.'
            : 'Unexpected response — review body excerpt.',
    })
  );

  // Probe 2: citation-builder root. Confirms the product is enabled
  // on the account and the endpoint path is correct.
  probes.push(
    await runProbe({
      name: 'citation-builder list (GET /data/v1/citation-builder/orders)',
      method: 'GET',
      url: `${BL_BASE}/data/v1/citation-builder/orders`,
      apiKey,
      notesFromStatus: (s) =>
        s === 401 || s === 403
          ? 'BAD: auth rejected on citation-builder — Citation Builder may not be enabled on this BL plan, or the endpoint path is wrong.'
          : s === 404
            ? 'BAD: 404 — endpoint path is almost certainly wrong. Check BL docs.'
            : s != null && s >= 200 && s < 300
              ? 'OK: endpoint exists and is callable.'
              : s != null && s >= 400 && s < 500
                ? 'PARTIAL: endpoint exists but rejected the request. Method may be wrong (some BL endpoints reject GET on collections); not necessarily a blocker.'
                : 'Unexpected response — review body excerpt.',
    })
  );

  // Probe 3: HEAD on the same path. Cheaper, sometimes BL rejects
  // GET on collection endpoints but accepts HEAD as an existence
  // check. Confirms 404 vs 405 vs 200/2xx.
  probes.push(
    await runProbe({
      name: 'citation-builder existence (HEAD /data/v1/citation-builder/orders)',
      method: 'HEAD',
      url: `${BL_BASE}/data/v1/citation-builder/orders`,
      apiKey,
      notesFromStatus: (s) =>
        s === 404
          ? 'BAD: endpoint not found at this path.'
          : s === 405
            ? 'OK: 405 (method not allowed) — endpoint exists, just doesn\'t allow HEAD. Path is correct.'
            : s != null && s >= 200 && s < 300
              ? 'OK: endpoint exists.'
              : 'Review body excerpt.',
    })
  );

  const overallOk =
    probes[0]!.status != null &&
    probes[0]!.status !== 401 &&
    probes[0]!.status !== 403 &&
    probes[1]!.status !== 404 &&
    probes[2]!.status !== 404;

  return NextResponse.json(
    {
      ok: overallOk,
      gate: {
        CITATION_BUILDER_ENABLED: process.env.CITATION_BUILDER_ENABLED ?? null,
      },
      summary: overallOk
        ? 'Probes pass. Safe to flip CITATION_BUILDER_ENABLED=true and run a single end-to-end test order against a sandbox or low-cost directory subset.'
        : 'One or more probes flagged a problem. Review notes per probe before flipping the gate.',
      probes,
    },
    { status: 200 }
  );
}

async function runProbe(args: {
  name: string;
  method: string;
  url: string;
  apiKey: string;
  body?: string;
  contentType?: string;
  notesFromStatus: (status: number | null) => string;
}): Promise<Probe> {
  try {
    const headers: Record<string, string> = { 'x-api-key': args.apiKey };
    if (args.contentType) headers['content-type'] = args.contentType;
    const res = await fetch(args.url, {
      method: args.method,
      headers,
      body: args.body,
    });
    let bodyExcerpt: string | null = null;
    if (args.method !== 'HEAD') {
      try {
        const text = await res.text();
        bodyExcerpt = text.slice(0, 400);
      } catch {
        bodyExcerpt = '(could not read body)';
      }
    }
    return {
      name: args.name,
      method: args.method,
      url: args.url,
      status: res.status,
      ok: res.ok,
      body_excerpt: bodyExcerpt,
      notes: args.notesFromStatus(res.status),
    };
  } catch (e) {
    return {
      name: args.name,
      method: args.method,
      url: args.url,
      status: null,
      ok: false,
      body_excerpt: e instanceof Error ? e.message : String(e),
      notes: 'Network error — could not reach BrightLocal.',
    };
  }
}
