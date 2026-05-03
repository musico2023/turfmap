/**
 * POST /api/nap/audit/[clientId] — initiate a NAP citation audit.
 * GET  /api/nap/audit/[clientId] — list audit history for this client.
 *
 * Both routes are agency-gated. NAP audits are an operator-only feature
 * in v1 — surfaced in the agency dashboard and fed to the AI Coach
 * prompt; no portal-side surface.
 *
 * Rate limit: 4 audits per client per 30 days (configurable below).
 * Citations rot slowly; this is plenty.
 *
 * v1 flow (per-directory async fan-out, since BrightLocal's public
 * Data API is per-directory not per-report):
 *   1. POST inserts a pending audit row.
 *   2. Fans out N Find Profile calls (one per directory in the
 *      DEFAULT_US_DIRECTORIES set), collects request_ids, persists
 *      them to nap_audits.brightlocal_requests, marks status=running.
 *   3. Returns the audit row id immediately.
 *   4. A separate poll endpoint (or cron, future) calls
 *      lib/brightlocal/client.pollAuditResults to check whether all
 *      request_ids are ready, and when so, summarizes findings and
 *      marks status=complete.
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import {
  initiateCitationAudit,
  type BusinessProfile,
} from '@/lib/brightlocal/client';
import { getDirectoriesForIndustry } from '@/lib/brightlocal/directories';
import type { ClientRow, NapAuditRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_AUDITS_PER_MONTH = 4;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ clientId: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { clientId } = await params;

  const supabase = getServerSupabase();

  // 1. Confirm client exists + has the structured NAP fields BL requires.
  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .maybeSingle<ClientRow>();
  if (!client) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }
  const missingFields = napFieldsMissing(client);
  if (missingFields.length > 0) {
    return NextResponse.json(
      {
        error: `client is missing NAP fields: ${missingFields.join(', ')}. Fill in the structured address (street/city/state/zip) and phone on the client settings page before running an audit.`,
      },
      { status: 400 }
    );
  }

  // 2. Rate-limit: count audits in the trailing 30 days.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { count: recentCount } = await supabase
    .from('nap_audits')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .gte('created_at', since);
  if ((recentCount ?? 0) >= MAX_AUDITS_PER_MONTH) {
    return NextResponse.json(
      {
        error: `rate limit: ${MAX_AUDITS_PER_MONTH} audits per client per 30 days. Try again later.`,
      },
      { status: 429 }
    );
  }

  // 3. Insert pending audit row first so we have a stable id even if
  //    the upstream fan-out partially fails (audit row holds the
  //    failure reason + per-directory rejection list).
  const { data: auditRow, error: insErr } = await supabase
    .from('nap_audits')
    .insert({
      client_id: clientId,
      triggered_by: auth.id,
      status: 'pending',
    })
    .select('*')
    .single<NapAuditRow>();
  if (insErr || !auditRow) {
    return NextResponse.json(
      {
        error: `nap_audits insert failed: ${insErr?.message ?? 'no row'}`,
      },
      { status: 500 }
    );
  }

  // 4. Fan out across the default directory set. If 0 directories
  //    accept (network outage, bad API key) the wrapper throws and
  //    we mark the row failed.
  const business: BusinessProfile = {
    name: client.business_name,
    street_address: client.street_address!,
    city: client.city!,
    region: client.region!,
    postcode: client.postcode!,
    telephone: client.phone!,
    country: client.country_code ?? 'USA',
  };

  try {
    // Industry-aware directory set: pediatric clinic → medical directories,
    // plumber → home-services, etc. Falls back to a tight universal set when
    // industry isn't filled in.
    const directories = getDirectoriesForIndustry(client.industry);
    const result = await initiateCitationAudit(business, directories);
    await supabase
      .from('nap_audits')
      .update({
        status: 'running',
        brightlocal_requests: result.requests,
        brightlocal_rejected: result.rejected,
      })
      .eq('id', auditRow.id);
    return NextResponse.json({
      auditId: auditRow.id,
      status: 'running',
      requestCount: result.requests.length,
      rejectedCount: result.rejected.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase
      .from('nap_audits')
      .update({
        status: 'failed',
        error_message: msg,
        completed_at: new Date().toISOString(),
      })
      .eq('id', auditRow.id);
    return NextResponse.json(
      {
        error: `BrightLocal audit failed to start: ${msg}`,
        auditId: auditRow.id,
      },
      { status: 502 }
    );
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ clientId: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { clientId } = await params;

  const supabase = getServerSupabase();
  const { data: rows, error } = await supabase
    .from('nap_audits')
    .select(
      'id, status, created_at, completed_at, total_citations, inconsistencies_count, missing_high_priority_count, error_message'
    )
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ audits: rows ?? [] });
}

function napFieldsMissing(client: ClientRow): string[] {
  const missing: string[] = [];
  if (!client.business_name) missing.push('business_name');
  if (!client.street_address) missing.push('street_address');
  if (!client.city) missing.push('city');
  if (!client.region) missing.push('region');
  if (!client.postcode) missing.push('postcode');
  if (!client.phone) missing.push('phone');
  return missing;
}
