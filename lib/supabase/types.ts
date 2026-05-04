/**
 * Hand-written Supabase types for Phase 1.
 *
 * These intentionally cover only the columns the test-scan touches.
 * Replace this file with `supabase gen types typescript --project-id ...`
 * output once the CLI is wired up — it'll generate the full Database type
 * including views and RPCs.
 */

export type ScanType = 'scheduled' | 'on_demand';
export type ScanStatus = 'queued' | 'running' | 'complete' | 'failed';
export type ScanFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly';
export type ClientStatus = 'active' | 'paused' | 'churned';

/** Three-state billing-mode for a client (added in migration 0008).
 *  Drives whether scheduled scans fire and whether Stripe owns the
 *  subscription state. See migration 0008 for the canonical
 *  semantics. */
export type BillingMode =
  | 'agency_managed'
  | 'one_time'
  | 'self_serve_subscription';

/** Mirrored from Stripe's `Subscription.status` field. Null for any
 *  client that isn't on a recurring plan. See migration 0008 for the
 *  CHECK constraint covering this set. */
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused';

/** Audit-tier + monitoring-tier ids. The five SKUs the public
 *  marketing tripwire offers. Mirrored on lead_orders.tier and
 *  /api/checkout/[tier]'s URL parameter. */
export type Tier = 'scan' | 'audit' | 'strategy' | 'pulse' | 'pulse_plus';

export type ClientRow = {
  id: string;
  /** Short (10-char) random user-facing identifier used in all URLs +
   *  dashboard links. The UUID id remains the primary key for foreign
   *  keys. Added in migration 0007. */
  public_id: string;
  business_name: string;
  /** Legacy/deprecated location columns — kept as deprecated mirrors of
   *  the primary client_locations row for backward-compat with code paths
   *  written before migration 0006. New code reads/writes through
   *  client_locations. A follow-up migration will drop them once every
   *  read site has been migrated. */
  address: string;
  phone: string | null;
  street_address: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  country_code: string | null;
  latitude: number;
  longitude: number;
  pin_lat: number | null;
  pin_lng: number | null;
  service_radius_miles: number | null;
  /** Brand-level fields — stay on clients permanently. */
  industry: string | null;
  primary_color: string | null;
  logo_url: string | null;
  status: ClientStatus | null;
  monthly_price_cents: number | null;
  /** Stripe Customer object id. Set on first Checkout session for this
   *  client. Pre-migration-0008 this column existed but only for
   *  agency-managed clients with manual Stripe links; post-0008 it's
   *  also populated for self-serve buyers via the order-fulfill
   *  pipeline + Stripe webhook. */
  stripe_customer_id: string | null;
  /** Three-state billing flag (added in migration 0008). Drives
   *  scheduled-scan eligibility + checkout flow. Defaults to
   *  'agency_managed' for backward compat. */
  billing_mode: BillingMode;
  /** Stripe Subscription id. Only set when billing_mode is
   *  'self_serve_subscription'. Null otherwise. */
  stripe_subscription_id: string | null;
  /** Mirrored from Stripe webhook events. Null for non-subscription
   *  billing modes. */
  subscription_status: SubscriptionStatus | null;
  onboarded_at: string | null;
  created_at: string | null;
};

/** A physical location of a client (added in migration 0006). One client
 *  has N locations; exactly one is_primary. NAP fields, scan-grid coords,
 *  and service radius live here, NOT on clients. */
export type ClientLocationRow = {
  id: string;
  client_id: string;
  /** Operator-facing short name (e.g. "Wychwood"). Defaults to `city` when null. */
  label: string | null;
  is_primary: boolean;
  address: string | null;
  street_address: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  country_code: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  pin_lat: number | null;
  pin_lng: number | null;
  service_radius_miles: number | null;
  /** Optional Google Business Profile URL for this location. */
  gbp_url: string | null;
  created_at: string | null;
};

export type TrackedKeywordRow = {
  id: string;
  client_id: string;
  /** Added in migration 0006: which location does this keyword belong to.
   *  Multi-location clients have different keywords per location. Existing
   *  rows are backfilled to the client's primary location. */
  location_id: string | null;
  keyword: string;
  is_primary: boolean | null;
  scan_frequency: ScanFrequency | null;
  created_at: string | null;
};

// Note: clients table also gains structured NAP columns in migration 0005
// (phone + street_address + city + region + postcode + country_code), and
// migration 0006 moves those into client_locations as the canonical
// source — clients still mirrors them as deprecated fields.

/** Citation audit history — see lib/brightlocal/client.ts. Operator-only. */
export type NapAuditStatus = 'pending' | 'running' | 'complete' | 'failed';

/** One BrightLocal request_id per directory in an audit's fan-out. */
export type NapAuditRequest = {
  directory: string;
  request_id: string;
};

export type NapAuditRejected = {
  directory: string;
  error: string;
};

export type NapAuditInconsistency = {
  field: 'name' | 'address' | 'phone';
  canonical: string;
  found: string;
  citation_url: string;
  directory: string;
};

export type NapAuditCitation = {
  directory: string;
  url: string;
  name: string | null;
  address: string | null;
  phone: string | null;
  /** Citation match status:
   *    matched       — listing's NAP matches the audited location
   *    mismatch      — listing exists but its NAP differs from the audited
   *                    location AND from every sibling location (real
   *                    inconsistency operator should fix)
   *    sibling_match — listing exists but matches a SIBLING location's NAP,
   *                    not the audited location's. Treated as
   *                    missing-from-this-location (the sibling's listing
   *                    occupies the directory but this storefront has no
   *                    listing of its own). Not flagged as an inconsistency.
   *    unverified    — directory returned a profile but with insufficient
   *                    NAP fields to compare. */
  status: 'matched' | 'mismatch' | 'sibling_match' | 'unverified';
};

export type NapAuditMissing = {
  directory: string;
  priority: 'high' | 'medium' | 'low';
  /** Optional context: when a sibling location's listing occupies this
   *  directory, the active location is still missing — but the operator
   *  should know they need to add this location alongside the existing
   *  sibling listing rather than create a fresh one. */
  occupied_by_sibling?: {
    sibling_label?: string | null;
    sibling_address?: string | null;
  };
};

export type NapAuditFindings = {
  citations: NapAuditCitation[];
  inconsistencies: NapAuditInconsistency[];
  missing: NapAuditMissing[];
};

export type NapAuditRow = {
  id: string;
  client_id: string;
  /** Added in migration 0006: which location was audited. Each location
   *  has its own NAP and is audited independently. Existing rows are
   *  backfilled to the client's primary location. */
  location_id: string | null;
  triggered_by: string | null;
  created_at: string | null;
  status: NapAuditStatus;
  /** Per-directory request_id map. Used to resume polling. */
  brightlocal_requests: NapAuditRequest[] | null;
  /** Directories BL rejected at initiate time. */
  brightlocal_rejected: NapAuditRejected[] | null;
  total_citations: number | null;
  inconsistencies_count: number | null;
  missing_high_priority_count: number | null;
  findings: NapAuditFindings | null;
  raw_response: unknown;
  completed_at: string | null;
  error_message: string | null;
};

/** Public share link for a scan — see /share/<id>. */
export type ScanShareLinkRow = {
  id: string;
  scan_id: string;
  created_by: string | null;
  created_at: string | null;
  expires_at: string;
  revoked_at: string | null;
  view_count: number | null;
  last_viewed_at: string | null;
  agency_label: string | null;
  cta_text: string | null;
  cta_url: string | null;
};

export type ScanRow = {
  id: string;
  client_id: string;
  /** Added in migration 0006: which physical location this scan was run
   *  against. Each location has its own scan grid + heatmap. Existing
   *  rows are backfilled to the client's primary location. */
  location_id: string | null;
  keyword_id: string;
  scan_type: ScanType;
  grid_size: number | null;
  status: ScanStatus | null;
  /** New score family (added 2026-05-02 in score-redesign migration). */
  turf_score: number | null;
  turf_reach: number | null;
  turf_rank: number | null;
  momentum: number | null;
  /** Deprecated: kept for historical safety, do not write to these on
   *  new scans. Replaced by turf_reach + turf_rank respectively. */
  top3_win_rate: number | null;
  turf_radius_units: number | null;
  total_points: number | null;
  failed_points: number | null;
  dfs_cost_cents: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string | null;
};

export type ScanPointRow = {
  id: string;
  scan_id: string;
  grid_x: number;
  grid_y: number;
  latitude: number;
  longitude: number;
  rank: number | null;
  business_found: boolean | null;
  competitors: unknown | null;
  raw_response: unknown | null;
  created_at: string | null;
};

/** Lifecycle of a Stripe Checkout session for a self-serve buyer.
 *
 *  - `pending`   : Stripe redirected to /order/success; row created
 *                  on first page load. Buyer hasn't yet submitted the
 *                  business-details form.
 *  - `fulfilled` : /api/orders/fulfill completed successfully — a
 *                  clients row was created, the scan was triggered,
 *                  and the delivery email was queued.
 *  - `failed`    : /api/orders/fulfill threw; surface in the support
 *                  queue for manual recovery.
 */
export type LeadOrderStatus = 'pending' | 'fulfilled' | 'failed';

/** A self-serve buyer's Stripe Checkout session. One row per session;
 *  unique by stripe_session_id. Created idempotently on the
 *  /order/success page load and updated by /api/orders/fulfill.
 *  Added in migration 0008. */
export type LeadOrderRow = {
  id: string;
  stripe_session_id: string;
  tier: Tier;
  email: string | null;
  /** Set once fulfillment creates the corresponding clients row.
   *  NULL means the buyer paid but never completed the form. */
  client_id: string | null;
  status: LeadOrderStatus;
  /** JSON blob mirrored from Stripe — typically
   *  { stripe_customer_id, payment_status, amount_total, currency }. */
  stripe_metadata: unknown | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};
