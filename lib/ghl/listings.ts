/**
 * GoHighLevel Listings provisioning — TurfMap citations vendor v2.
 *
 * Replaces the BrightLocal Citation Builder flow (walled by BL's 1-active-
 * location plan cap, 2026-07-11). GHL Listings (Uberall engine) syncs a
 * business's profile across 70+ directories for $30/mo wholesale per
 * sub-account with NO location cap, resellable at our markup inside Pulse+.
 *
 * What this module does: create a GHL SUB-ACCOUNT carrying the client's
 * NAP + website, and return its id. What it deliberately does NOT do:
 * toggle Listings ON — GHL exposes no public API for that (verified against
 * the v2 docs, 2026-07-11), so activation is a one-click operator step in
 * the GHL UI. The build route persists the order as 'awaiting_activation'
 * and pings the operator with the profile; the operator flips the toggle
 * and hits "Mark activated" on the TurfMap panel.
 *
 * API contract (marketplace.gohighlevel.com/docs, verified 2026-07-11):
 *   POST https://services.leadconnectorhq.com/locations/
 *   Headers  Authorization: Bearer <AGENCY token>   ← NOT the location PIT
 *            Version: 2021-07-28
 *   Scope    locations.write
 *   Body     { name, companyId (required), phone, address, city, state,
 *              country (ISO-2), postalCode, website, prospectInfo }
 *   Resp     { id, ... }
 *   ⚠ Endpoint is gated to the GHL Agency Pro ($497) plan. On lower plans
 *     it 4xxs — we surface kind 'plan_gated' and the caller persists the
 *     order anyway for MANUAL sub-account creation (available on every
 *     plan via the UI). The flow degrades to one extra operator click,
 *     it never blocks the buyer.
 *
 * NOTE this uses a DIFFERENT token than lib/integrations/highlevel.ts —
 * that module's PIT is scoped to the Fourdots sub-account (contacts /
 * opportunities for cold outbound). Sub-account creation requires an
 * AGENCY-level Private Integration Token. Required env:
 *
 *   GHL_LISTINGS_ENABLED        'true' to arm this module
 *   HIGHLEVEL_AGENCY_PIT_TOKEN  agency-level PIT with locations.write
 *   HIGHLEVEL_COMPANY_ID        the agency/company id (body requires it)
 */

import type { CitationSubmittedProfile } from '@/lib/supabase/types';

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

export type ProvisionInput = {
  profile: CitationSubmittedProfile;
  /** Operator contact (surfaced as the sub-account prospect info). */
  contact: { firstname: string; lastname: string; email: string };
  /** Our client_locations.id — stamped into the sub-account name suffix
   *  is NOT wanted (client-visible); kept for logging only. */
  locationReference: string;
};

export type ProvisionResult =
  | { ok: true; ghlLocationId: string }
  | {
      ok: false;
      kind: 'not_configured' | 'plan_gated' | 'invalid_profile' | 'remote_error';
      message: string;
    };

/** Map our stored ISO-3166 alpha-3 country codes to the ISO-2 codes the
 *  GHL locations endpoint requires. Only the markets we sell in; anything
 *  else falls back to US (and the operator corrects it during the
 *  activation click if ever wrong). Exported for the verify guard. */
export function countryAlpha3To2(code: string | null | undefined): string {
  switch ((code ?? '').trim().toUpperCase()) {
    case 'CAN':
    case 'CA':
      return 'CA';
    case 'GBR':
    case 'GB':
      return 'GB';
    case 'AUS':
    case 'AU':
      return 'AU';
    case 'USA':
    case 'US':
    default:
      return 'US';
  }
}

/** Pure — build the POST /locations/ body from a citations profile.
 *  Exported for the verify guard. */
export function buildGhlLocationBody(
  input: ProvisionInput,
  companyId: string
): Record<string, unknown> {
  const p = input.profile;
  const body: Record<string, unknown> = {
    name: p.business_name,
    companyId,
    country: countryAlpha3To2(p.country_code),
  };
  if (p.phone) body.phone = p.phone;
  if (p.street_address) body.address = p.street_address;
  if (p.city) body.city = p.city;
  if (p.region) body.state = p.region;
  if (p.postcode) body.postalCode = p.postcode;
  if (p.website) body.website = p.website;
  body.prospectInfo = {
    firstName: input.contact.firstname,
    lastName: input.contact.lastname,
    email: input.contact.email,
  };
  return body;
}

/**
 * Create the GHL sub-account for this citations order. Idempotency is the
 * caller's job (the citation_orders one-open-per-location constraint
 * already blocks double submits for a location).
 */
export async function provisionGhlListingsLocation(
  input: ProvisionInput
): Promise<ProvisionResult> {
  if (process.env.GHL_LISTINGS_ENABLED !== 'true') {
    return {
      ok: false,
      kind: 'not_configured',
      message:
        'GHL Listings is gated off. Set GHL_LISTINGS_ENABLED=true after configuring the agency token.',
    };
  }
  const token = process.env.HIGHLEVEL_AGENCY_PIT_TOKEN;
  const companyId = process.env.HIGHLEVEL_COMPANY_ID;
  if (!token || !companyId) {
    // Treat missing agency credentials as the plan-gated path: the order
    // still persists and the operator creates the sub-account manually.
    return {
      ok: false,
      kind: 'plan_gated',
      message:
        'HIGHLEVEL_AGENCY_PIT_TOKEN / HIGHLEVEL_COMPANY_ID not set — sub-account needs manual creation in the GHL UI.',
    };
  }
  if (!input.profile.business_name?.trim()) {
    return {
      ok: false,
      kind: 'invalid_profile',
      message: 'business_name is required to create a GHL sub-account.',
    };
  }

  let res: Response;
  try {
    res = await fetch(`${GHL_API_BASE}/locations/`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        version: GHL_API_VERSION,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(buildGhlLocationBody(input, companyId)),
    });
  } catch (e) {
    return {
      ok: false,
      kind: 'remote_error',
      message: e instanceof Error ? e.message : String(e),
    };
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // 401/403 on this endpoint = wrong token type OR the Agency-Pro plan
    // gate. Either way the remedy is the same: manual creation. Other 4xx/
    // 5xx are real errors worth surfacing distinctly.
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        kind: 'plan_gated',
        message: `GHL locations API rejected the create (${res.status}) — likely the Agency Pro plan gate or a non-agency token. Create the sub-account manually. [${truncate(text, 160)}]`,
      };
    }
    return {
      ok: false,
      kind: 'remote_error',
      message: `GHL POST /locations/ ${res.status}: ${truncate(text, 240)}`,
    };
  }

  let json: { id?: string } = {};
  try {
    json = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    /* fall through */
  }
  if (!json.id) {
    return {
      ok: false,
      kind: 'remote_error',
      message: `GHL create response missing location id: ${truncate(text, 240)}`,
    };
  }
  return { ok: true, ghlLocationId: json.id };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}
