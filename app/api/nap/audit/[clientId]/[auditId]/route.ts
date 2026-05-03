/**
 * GET /api/nap/audit/[clientId]/[auditId] — read a single audit + advance
 * its status if it's still running.
 *
 * Why "GET advances state": BrightLocal's Listings API is per-directory
 * async — each directory has its own request_id and we have to poll
 * each one individually. Rather than running a Vercel cron, we just
 * have the operator's dashboard hit this endpoint. When all
 * request_ids are ready, we summarize findings inline and persist the
 * audit row as `complete`. Idempotent: a second GET on a complete
 * audit just returns the row.
 *
 * (A scheduled fallback poll via Vercel Cron is a Phase 2 improvement.)
 */

import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { requireAgencyUserForApi } from '@/lib/auth/agency';
import { resolveClientUuid } from '@/lib/supabase/client-lookup';
import {
  pollAuditResults,
  summarizeFindings,
  type BusinessProfile,
} from '@/lib/brightlocal/client';
import type {
  ClientRow,
  NapAuditFindings,
  NapAuditRequest,
  NapAuditRow,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ clientId: string; auditId: string }> }
) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  const { clientId: clientParam, auditId } = await params;

  const supabase = getServerSupabase();
  const clientId = await resolveClientUuid(supabase, clientParam);
  if (!clientId) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 });
  }

  // 1. Load the audit row.
  const { data: audit } = await supabase
    .from('nap_audits')
    .select('*')
    .eq('id', auditId)
    .eq('client_id', clientId)
    .maybeSingle<NapAuditRow>();
  if (!audit) {
    return NextResponse.json({ error: 'audit not found' }, { status: 404 });
  }

  // 2. Already done — return as-is.
  if (audit.status === 'complete' || audit.status === 'failed') {
    return NextResponse.json({ audit });
  }

  // 3. No requests yet (still pending insert race) — let caller retry.
  const requests = (audit.brightlocal_requests ?? []) as NapAuditRequest[];
  if (requests.length === 0) {
    return NextResponse.json({ audit });
  }

  // 4. Poll BL. If any request_ids aren't ready, leave status=running.
  let summary;
  try {
    summary = await pollAuditResults(requests);
  } catch (e) {
    // Network failure — don't mark the audit failed; let the caller
    // retry. Just surface the message.
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { audit, pollError: msg },
      { status: 200 }
    );
  }
  if (!summary.allReady) {
    return NextResponse.json({
      audit,
      progress: {
        ready: summary.perDirectory.filter((d) => d.ready).length,
        total: summary.perDirectory.length,
      },
    });
  }

  // 5. All ready. Build findings and persist.
  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .maybeSingle<ClientRow>();
  if (!client) {
    return NextResponse.json(
      { error: 'client not found while finalizing audit' },
      { status: 404 }
    );
  }
  const canonical: BusinessProfile = {
    name: client.business_name,
    street_address: client.street_address ?? '',
    city: client.city ?? '',
    region: client.region ?? '',
    postcode: client.postcode ?? '',
    telephone: client.phone ?? '',
    country: client.country_code ?? 'USA',
  };
  const findings: NapAuditFindings = summarizeFindings(
    summary.perDirectory,
    canonical
  );
  const totalCitations = findings.citations.length;
  const inconsistenciesCount = findings.inconsistencies.length;
  const missingHigh = findings.missing.filter((m) => m.priority === 'high').length;

  const { data: updated } = await supabase
    .from('nap_audits')
    .update({
      status: 'complete',
      findings,
      raw_response: summary.perDirectory,
      total_citations: totalCitations,
      inconsistencies_count: inconsistenciesCount,
      missing_high_priority_count: missingHigh,
      completed_at: new Date().toISOString(),
    })
    .eq('id', auditId)
    .select('*')
    .single<NapAuditRow>();

  return NextResponse.json({ audit: updated ?? audit });
}
