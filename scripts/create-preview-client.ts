/**
 * One-off preview client + 81-point scan for a new lead.
 *
 * Runs the exact same path the /score lander takes
 * (lib/score/createPreviewClient), so the resulting /share/<id> page
 * renders identically to what a self-serve lead would get — just
 * driven from the operator side when a lead arrives out-of-band
 * (inbound DM, referral, cold-outreach reply, etc.).
 *
 * What it creates (all rollback-guarded by createPreviewClient):
 *   - clients row: is_preview=true, status='paused',
 *     billing_mode='agency_managed' → invisible to the operator
 *     dashboard, the weekly-scan cron, and lead-order counts
 *   - client_locations primary row with structured NAP + Place ID
 *   - tracked_keywords primary row
 *   - lead_orders stub (source='score_preview', status='pending')
 *   - 81-point DFS Live scan (~$0.16 real spend)
 *   - scan_share_links row, 90-day TTL
 *
 * Deliberately no AI Coach — that sits behind the $99 unlock.
 *
 * Business identity is resolved ahead of time from the lead's GBP
 * (DataForSEO My Business Info) rather than typed by hand, so the
 * NAP fields the downstream NAP audit needs are authoritative.
 *
 * Run with:  npx tsx scripts/create-preview-client.ts
 * Edit the LEAD block below for each new lead.
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import dns from 'node:dns';

// api.dataforseo.com only publishes A records; dual-stack networks
// sometimes flake on AAAA. Same guard the other scan scripts use.
dns.setDefaultResultOrder('ipv4first');
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

import { createPreviewClient } from '../lib/score/createPreviewClient';
import { getServerSupabase } from '../lib/supabase/server';

// ─── Lead (edit per run) ───────────────────────────────────────────────────
// Sourced from the lead's Google Business Profile via DataForSEO
// My Business Info — place_id, coords, NAP and category are Google's
// own values, not hand-typed.
const LEAD = {
  businessName: 'Clear Choice Windows & Doors',
  address: '7244 SW Durham Rd #900, Tigard, OR 97224',
  keyword: 'window replacement',
  // No lead email captured yet — the preview's lead_orders row needs
  // an owner, and nothing on this path emails it. Operator address
  // keeps the record valid without touching the prospect's inbox.
  email: 'anthony@fourdots.ca',
  phone: '+1 503-850-7090',
  latitude: 45.399269,
  longitude: -122.752151,
  components: {
    street_address: '7244 SW Durham Rd #900',
    city: 'Tigard',
    // Full state name, not 'OR' — 2-letter codes have broken DFS
    // location_name resolution on the citation/NAP probes before.
    region: 'Oregon',
    postcode: '97224',
    country_code: 'USA',
  },
  googlePlaceId: 'ChIJ61cYu8dylVQRrJk9e-o-JCA',
  // Google's place_types enum value. Maps to the 'windows & doors'
  // trade in lib/google/primaryTypeToIndustry, which drives the
  // share page's trade-economics inference.
  googlePrimaryType: 'window_installation_service',
} as const;

async function main() {
  const supabase = getServerSupabase();

  console.log('▸ Creating preview client + running 81-point scan…');
  console.log(`  business : ${LEAD.businessName}`);
  console.log(`  address  : ${LEAD.address}`);
  console.log(`  keyword  : "${LEAD.keyword}"`);
  console.log(`  center   : ${LEAD.latitude}, ${LEAD.longitude}`);
  console.log('  (real DFS spend — ~81 Live Mode requests, ~$0.16)\n');

  const t0 = Date.now();
  const result = await createPreviewClient(supabase, {
    businessName: LEAD.businessName,
    address: LEAD.address,
    keyword: LEAD.keyword,
    email: LEAD.email,
    phone: LEAD.phone,
    latitude: LEAD.latitude,
    longitude: LEAD.longitude,
    components: { ...LEAD.components },
    googlePlaceId: LEAD.googlePlaceId,
    googlePrimaryType: LEAD.googlePrimaryType,
  });
  const dtSec = ((Date.now() - t0) / 1000).toFixed(1);

  if (!result.ok) {
    console.error(`\n✗ Failed (${result.kind}) after ${dtSec}s: ${result.message}`);
    if (result.kind === 'scan') {
      console.error(
        '  client/location/keyword rows were preserved — retry the scan ' +
          'from the agency dashboard, or the GC cron reaps them at 30d.'
      );
    }
    process.exit(1);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✓ Preview scan complete in ${dtSec}s`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  TurfScore  : ${result.turfScore}`);
  console.log(`  client_id  : ${result.clientId}`);
  console.log(`  scan_id    : ${result.scanId}`);
  console.log(`  share      : https://turfmap.ai/share/${result.shareId}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
