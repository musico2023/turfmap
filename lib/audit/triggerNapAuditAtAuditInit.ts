/**
 * Trigger a BrightLocal / DFS NAP audit at Visibility Audit
 * initialization.
 *
 * The base `maybeRunNapAudit` helper already runs idempotently from
 * `runScanForLocation` — meaning every scan attempt SHOULD fire one.
 * But `locationToBusinessProfile` requires a complete NAP block
 * (businessName + phone + street_address + city + region + postcode),
 * and cold-prospect COLDSCAN clients are created with NULL phone +
 * NULL structured address fields (the prospect doesn't fill an
 * intake form). The scan-time call silently skips with
 * `location missing structured NAP fields`, leaving the
 * `nap_audits` table empty + the Roadmap PDF's NAP page blank.
 *
 * This helper closes that gap by ENRICHING the location with phone
 * + structured-address fields from Google Places (using the GBP
 * listing the existing onboarding-enrichment path stamps a place_id
 * for) BEFORE calling `maybeRunNapAudit`. Wired into the two
 * audit-initialization paths:
 *
 *   1. /api/orders/fulfill — audit-tier branch, right after
 *      createVisibilityAudit succeeds. For paid audit buyers the
 *      location is already NAP-complete (intake form captured phone),
 *      so enrichment short-circuits + the audit fires immediately.
 *   2. lib/audit/bootstrapCompAudit — after the comp visibility_audits
 *      row is created. For Yohann / Ainger Group Roofing-style
 *      bootstraps, enrichment fills the missing NAP block from GBP
 *      and the audit fires automatically.
 *
 * Async fire-and-forget by design — NAP audits take ~5-15min to
 * complete. The at-purchase Roadmap PDF still goes out immediately
 * with whatever NAP findings exist (often empty on first run); the
 * T-24h pre-call cron regenerates the PDF with the populated
 * findings once the audit completes.
 */

import { getServerSupabase } from '@/lib/supabase/server';
import { maybeRunNapAudit } from '@/lib/brightlocal/autoAudit';
import { findAndVerifyPlace, getPlaceDetails } from '@/lib/google/places';
import { postOperatorSlack } from '@/lib/audit/operatorSlack';
import type {
  ClientLocationRow,
  ClientRow,
  VisibilityAuditRow,
} from '@/lib/supabase/types';

type SupabaseClientLike = ReturnType<typeof getServerSupabase>;

export type TriggerNapAuditResult =
  | {
      ok: true;
      ran: boolean;
      reason?: string;
      enriched: boolean;
    }
  | { ok: false; stage: string; error: string };

/**
 * Run after a `visibility_audits` row is created. Enriches the
 * client's primary location with phone + structured address from
 * Google Places when missing, then kicks off a NAP audit. The
 * returned promise resolves quickly even though the underlying NAP
 * audit run is long-running — callers should NOT await this in a
 * request-blocking position; use a fire-and-forget pattern.
 */
export async function triggerNapAuditAtAuditInit(
  supabase: SupabaseClientLike,
  auditId: string,
  options: { operatorOrigin?: string } = {}
): Promise<TriggerNapAuditResult> {
  // 1. Load the audit + its anchors (client, primary location).
  const { data: audit } = await supabase
    .from('visibility_audits')
    .select('id, client_id')
    .eq('id', auditId)
    .maybeSingle<Pick<VisibilityAuditRow, 'id' | 'client_id'>>();
  if (!audit) {
    return { ok: false, stage: 'load-audit', error: 'audit not found' };
  }

  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('id', audit.client_id)
    .maybeSingle<ClientRow>();
  if (!client) {
    return { ok: false, stage: 'load-client', error: 'client not found' };
  }

  const { data: location } = await supabase
    .from('client_locations')
    .select('*')
    .eq('client_id', audit.client_id)
    .eq('is_primary', true)
    .maybeSingle<ClientLocationRow>();
  if (!location) {
    return {
      ok: false,
      stage: 'load-location',
      error: 'no primary location for client',
    };
  }

  // 2. Check whether the location is already NAP-ready. If yes,
  //    short-circuit and call maybeRunNapAudit directly (this is the
  //    paid-audit path — intake form already captured phone +
  //    structured address from Mapbox).
  const napReady =
    Boolean(location.phone) &&
    Boolean(location.street_address) &&
    Boolean(location.city) &&
    Boolean(location.region) &&
    Boolean(location.postcode);

  let enriched = false;
  if (!napReady) {
    // 3. Enrich from Google Places. We use findAndVerifyPlace which
    //    handles the lat/lng-biased Text Search → getPlaceDetails flow
    //    with name-similarity guardrails so we don't pull a wrong
    //    business's NAP. Same path the existing
    //    enrichLocationFromOnboarding uses, except we ALSO stamp
    //    phone + structured fields on the location row.
    if (
      typeof location.latitude !== 'number' ||
      typeof location.longitude !== 'number'
    ) {
      // No geo to bias from — can't search safely. Skip but log.
      return {
        ok: true,
        ran: false,
        reason: 'location missing lat/lng — cannot enrich via Places',
        enriched: false,
      };
    }
    try {
      const verified = await findAndVerifyPlace({
        businessName: client.business_name,
        latitude: location.latitude,
        longitude: location.longitude,
      });
      if (!verified) {
        await pingSlackEnrichmentSkipped({
          businessName: client.business_name,
          publicId: client.public_id,
          reason: 'GBP not found via Places lookup',
          origin: options.operatorOrigin,
        });
        return {
          ok: true,
          ran: false,
          reason: 'GBP not found via Places — manual fill needed',
          enriched: false,
        };
      }
      // findAndVerifyPlace returns details, but only if we re-fetch
      // with the new field-mask we'll get addressComponents.
      const details =
        verified.details.addressComponents
          ? verified.details
          : await getPlaceDetails(verified.details.placeId);
      const components = details?.addressComponents ?? null;
      const phone = details?.nationalPhoneNumber ?? null;

      const updates: Partial<ClientLocationRow> = {};
      if (!location.phone && phone) updates.phone = phone;
      if (!location.street_address && components?.streetAddress)
        updates.street_address = components.streetAddress;
      if (!location.city && components?.city) updates.city = components.city;
      if (!location.region && components?.region)
        updates.region = components.region;
      if (!location.postcode && components?.postcode)
        updates.postcode = components.postcode;
      if (!location.country_code && components?.countryCode)
        updates.country_code = components.countryCode;
      // Also stamp google_place_id since we resolved it here — saves
      // a duplicate findAndVerifyPlace on the next AI Coach run.
      if (!location.google_place_id) {
        updates.google_place_id = verified.details.placeId;
        updates.google_place_match_status = 'auto';
      }

      if (Object.keys(updates).length > 0) {
        const { error: updateErr } = await supabase
          .from('client_locations')
          .update(updates)
          .eq('id', location.id);
        if (updateErr) {
          return {
            ok: false,
            stage: 'persist-enrichment',
            error: updateErr.message,
          };
        }
        // Reflect the stamps in-memory for the readiness re-check below.
        Object.assign(location, updates);
        enriched = true;
      }

      // 4. Re-check readiness post-enrichment. If still incomplete,
      //    Slack-ping Anthony so he knows manual fill is needed.
      const nowReady =
        Boolean(location.phone) &&
        Boolean(location.street_address) &&
        Boolean(location.city) &&
        Boolean(location.region) &&
        Boolean(location.postcode);
      if (!nowReady) {
        await pingSlackEnrichmentSkipped({
          businessName: client.business_name,
          publicId: client.public_id,
          reason: `GBP enrichment incomplete — missing: ${reportMissing(location)}`,
          origin: options.operatorOrigin,
        });
        return {
          ok: true,
          ran: false,
          reason: `enrichment incomplete (${reportMissing(location)})`,
          enriched,
        };
      }
    } catch (e) {
      return {
        ok: false,
        stage: 'enrich-places',
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // 5. Fire the NAP audit. maybeRunNapAudit handles idempotency on
  //    the recent-audit window so re-calls inside 30 days are no-ops.
  try {
    const result = await maybeRunNapAudit(
      supabase,
      audit.client_id,
      'audit-init',
      location.id
    );
    return {
      ok: true,
      ran: result.ran,
      reason: result.reason,
      enriched,
    };
  } catch (e) {
    return {
      ok: false,
      stage: 'maybe-run-nap-audit',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function reportMissing(location: ClientLocationRow): string {
  const missing: string[] = [];
  if (!location.phone) missing.push('phone');
  if (!location.street_address) missing.push('street_address');
  if (!location.city) missing.push('city');
  if (!location.region) missing.push('region');
  if (!location.postcode) missing.push('postcode');
  return missing.join(', ') || 'none';
}

async function pingSlackEnrichmentSkipped(args: {
  businessName: string;
  publicId: string;
  reason: string;
  origin: string | undefined;
}): Promise<void> {
  const origin = args.origin ?? 'https://turfmap.ai';
  try {
    await postOperatorSlack({
      text: `⚠️ NAP audit skipped at audit-init: ${args.businessName} — ${args.reason}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*⚠️ NAP audit didn't trigger at audit-init*\n*${args.businessName}*\nReason: ${args.reason}\n\nThe Roadmap PDF's NAP page will render blank until the buyer's structured NAP fields are populated. Either fill them on the location row manually or use the operator endpoint once it ships.`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `<${origin}/clients/${args.publicId}|Open buyer in agency dashboard →>`,
            },
          ],
        },
      ],
    });
  } catch (e) {
    console.error(
      '[triggerNapAuditAtAuditInit] Slack ping threw',
      e instanceof Error ? e.message : String(e)
    );
  }
}
