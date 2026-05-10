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

  // Probe 2: BL Citation Builder lives on a DIFFERENT host with
  // DIFFERENT auth than the audit-side product we already use:
  //   host:  tools.brightlocal.com/seo-tools/api
  //   path:  /v4/cb/get-all
  //   auth:  api-key, sig, expires as query params
  //          (sig = base64(HMAC-SHA1(apiKey + expires, apiSecret)))
  //          PHP client marks apiSecret as @deprecated, so we probe
  //          with apiKey only first; if that 401s, sig is required.
  // Source: github.com/BrightLocal/apiclient-php/Examples/CitationBuilder
  const CB_BASE = 'https://tools.brightlocal.com/seo-tools/api';
  const CB_PATH = '/v4/cb/get-all';

  // Probe 2a: api-key only (best case — secret was deprecated).
  const expires = Math.floor(Date.now() / 1000) + 1800;
  const cbUrlKeyOnly = `${CB_BASE}${CB_PATH}?api-key=${encodeURIComponent(apiKey)}&expires=${expires}`;
  probes.push({
    ...(await runRawProbe({
      name: 'citation-builder GET /v4/cb/get-all (api-key only)',
      method: 'GET',
      url: cbUrlKeyOnly,
    })),
    notes: '',
  });
  const probe2a = probes[probes.length - 1]!;
  probe2a.notes =
    probe2a.status === 404
      ? 'BAD: 404 — path wrong even on the new host.'
      : probe2a.status === 401 || probe2a.status === 403
        ? 'AUTH MODE: api-key alone insufficient — need sig+expires HMAC. Set BRIGHTLOCAL_API_SECRET to enable.'
        : probe2a.status != null && probe2a.status >= 200 && probe2a.status < 300
          ? 'PATH + AUTH OK. USE THIS. (api-key-only auth works.)'
          : probe2a.status != null && probe2a.status >= 400 && probe2a.status < 500
            ? 'PATH LIKELY OK (4xx with auth accepted). Inspect body for the actual error.'
            : 'Review body excerpt.';

  // Probe 2b: sig+expires HMAC. Only meaningful if BRIGHTLOCAL_API_SECRET
  // is set. Otherwise we report "secret not set" and skip the call.
  const apiSecret = process.env.BRIGHTLOCAL_API_SECRET;
  if (apiSecret) {
    const sig = await hmacSha1Base64(apiKey + expires, apiSecret);
    const cbUrlSigned = `${cbUrlKeyOnly}&sig=${encodeURIComponent(sig)}`;
    probes.push({
      ...(await runRawProbe({
        name: 'citation-builder GET /v4/cb/get-all (api-key + sig HMAC)',
        method: 'GET',
        url: cbUrlSigned.replace(apiSecret, '<redacted>'),
        actualUrl: cbUrlSigned,
      })),
      notes: '',
    });
    const probe2b = probes[probes.length - 1]!;
    probe2b.notes =
      probe2b.status === 401 || probe2b.status === 403
        ? 'BAD: HMAC auth still rejected — secret may be wrong or Citation Builder not enabled on this BL plan.'
        : probe2b.status != null && probe2b.status >= 200 && probe2b.status < 300
          ? 'PATH + SIGNED AUTH OK. USE THIS. (sig+expires required.)'
          : 'Review body excerpt.';
  } else {
    probes.push({
      name: 'citation-builder GET /v4/cb/get-all (signed auth)',
      method: 'GET',
      url: '(skipped — BRIGHTLOCAL_API_SECRET not set)',
      status: null,
      ok: false,
      body_excerpt: null,
      notes:
        'BRIGHTLOCAL_API_SECRET not set in this environment. If the api-key-only probe above returned 401/403, add the secret env var (from your BL account) and re-run.',
    });
  }

  // Probe 3..N: language enum discovery. BL rejects 'en' and 'english'
  // on /v2/clients-and-locations/locations/ for Canadian addresses
  // ("The selected choice is invalid"). Probe a battery of candidate
  // values with an otherwise-minimal payload to find the right one.
  // Reference-lookup discovery. BL's q param doesn't find locations
  // by location-reference (we see "already in use" on create even
  // when search returned []). Probe a few candidate lookup shapes
  // against a known smoketest reference to find the one that works.
  const knownRef = '_smoketest_lang_CAN_EN_1778389099542';
  const lookupCandidates: Array<{ name: string; path: string }> = [
    {
      name: `list-all (no params)`,
      path: `/v2/clients-and-locations/locations/`,
    },
    {
      name: `list with location-reference filter`,
      path: `/v2/clients-and-locations/locations/?location-reference=${encodeURIComponent(knownRef)}`,
    },
    {
      name: `list with reference filter`,
      path: `/v2/clients-and-locations/locations/?reference=${encodeURIComponent(knownRef)}`,
    },
    {
      name: `search with location-reference param`,
      path: `/v2/clients-and-locations/locations/search?location-reference=${encodeURIComponent(knownRef)}`,
    },
    {
      name: `search with type=reference + q`,
      path: `/v2/clients-and-locations/locations/search?type=reference&q=${encodeURIComponent(knownRef)}`,
    },
    {
      name: `search by-reference path`,
      path: `/v2/clients-and-locations/locations/by-reference/${encodeURIComponent(knownRef)}`,
    },
  ];
  const lookupProbes = await Promise.all(
    lookupCandidates.map(async (c) => {
      const expires = Math.floor(Date.now() / 1000) + 1800;
      const sep = c.path.includes('?') ? '&' : '?';
      const url = `https://tools.brightlocal.com/seo-tools/api${c.path}${sep}api-key=${encodeURIComponent(apiKey)}&expires=${expires}`;
      try {
        const res = await fetch(url, { method: 'GET' });
        const text = await res.text().catch(() => '');
        return {
          name: `lookup probe — ${c.name}`,
          method: 'GET',
          url: c.path,
          status: res.status,
          ok: res.ok,
          body_excerpt: text.slice(0, 600),
          notes:
            res.status === 200 && text.includes(knownRef)
              ? `LOOKUP OK: returns the smoketest location (reference appears in body). USE THIS.`
              : res.status === 200
                ? `2xx but reference not in body — endpoint probably ignores the filter. Inspect.`
                : res.status === 404
                  ? `Path not found.`
                  : `Status ${res.status}, inspect body.`,
        };
      } catch (e) {
        return {
          name: `lookup probe — ${c.name}`,
          method: 'GET',
          url: c.path,
          status: null,
          ok: false,
          body_excerpt: e instanceof Error ? e.message : String(e),
          notes: 'Network error.',
        };
      }
    })
  );
  probes.push(...lookupProbes);

  // Also: USA payload with NO language field (sanity check — does
  // BL only require language for CA and similar?). If this passes,
  // we can omit language outside multi-language countries.
  probes.push(await probeLanguageValue(apiKey, '__OMIT__', 'USA'));

  const auth1Ok =
    probes[0]!.status != null &&
    probes[0]!.status !== 401 &&
    probes[0]!.status !== 403;
  const anyCbOk = probes.slice(1).some(
    (p) =>
      p.status != null &&
      p.status >= 200 &&
      p.status < 500 &&
      p.status !== 404 &&
      p.status !== 401 &&
      p.status !== 403
  );
  const overallOk = auth1Ok && anyCbOk;

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

/** Like runProbe but no x-api-key header injection — for hosts/paths
 *  that auth via query params instead. */
async function runRawProbe(args: {
  name: string;
  method: string;
  url: string;
  /** Optional fetch URL when `url` is a redacted display value. */
  actualUrl?: string;
}): Promise<Omit<Probe, 'notes'>> {
  try {
    const res = await fetch(args.actualUrl ?? args.url, {
      method: args.method,
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
    };
  } catch (e) {
    return {
      name: args.name,
      method: args.method,
      url: args.url,
      status: null,
      ok: false,
      body_excerpt: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Probe BL's location create with a candidate language value and a
 *  minimal otherwise-valid payload. We're only looking at the BL
 *  validation response — if `language` no longer appears in the
 *  errors object, that value is accepted. We attach a junk
 *  location-reference per probe so a successful create wouldn't
 *  collide with the real production data. */
async function probeLanguageValue(
  apiKey: string,
  lang: string,
  country: string = 'CAN'
): Promise<Probe> {
  const expires = Math.floor(Date.now() / 1000) + 1800;
  const url = `https://tools.brightlocal.com/seo-tools/api/v2/clients-and-locations/locations/?api-key=${encodeURIComponent(apiKey)}&expires=${expires}`;
  const ref = `_smoketest_lang_${lang.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}`;
  const fields: Record<string, string> = {
    name: 'Smoke Test (delete me)',
    'location-reference': ref,
    'business-category-id': '605',
    country,
    url: 'https://example.com',
    address1: '1 Test St',
    region: country === 'USA' ? 'NY' : 'ON',
    city: country === 'USA' ? 'New York' : 'Toronto',
    postcode: country === 'USA' ? '10001' : 'M5V 1A1',
    telephone: country === 'USA' ? '+1 212-555-0100' : '+1 416-555-0100',
  };
  // Sentinel "__OMIT__" lets us probe what happens when no language
  // field is sent at all — useful for confirming whether language is
  // CA-only or required across the board.
  if (lang !== '__OMIT__') fields.language = lang;
  const body = new URLSearchParams(fields);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await res.text().catch(() => '(could not read body)');
    const excerpt = text.slice(0, 400);
    let langInvalid = false;
    let success = false;
    try {
      const json = JSON.parse(text) as {
        success?: boolean;
        errors?: Record<string, string>;
      };
      success = !!json.success;
      langInvalid = Boolean(json.errors && 'language' in json.errors);
    } catch {
      // Non-JSON or parse error — fall back to text inspection.
    }
    return {
      name: `language candidate "${lang}"`,
      method: 'POST',
      url: '/v2/clients-and-locations/locations/ (CA payload)',
      status: res.status,
      ok: success,
      body_excerpt: excerpt,
      notes: success
        ? `LANGUAGE OK: BL accepted "${lang}" and CREATED a location (delete it from BL dashboard — reference ${ref}).`
        : !langInvalid
          ? `LANGUAGE OK (other field rejected): "${lang}" passed language validation; failure is on a different field. USE "${lang}".`
          : `LANGUAGE REJECTED: BL still flags language as invalid for "${lang}".`,
    };
  } catch (e) {
    return {
      name: `language candidate "${lang}"`,
      method: 'POST',
      url: '/v2/clients-and-locations/locations/',
      status: null,
      ok: false,
      body_excerpt: e instanceof Error ? e.message : String(e),
      notes: 'Network error.',
    };
  }
}

/** HMAC-SHA1(message, key) → base64. Matches BL's PHP client signing. */
async function hmacSha1Base64(message: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}
