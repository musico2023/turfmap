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

export type ClientRow = {
  id: string;
  business_name: string;
  /** Single-string canonical address kept for display/back-compat.
   *  Structured fields below are required for any BrightLocal NAP audit. */
  address: string;
  /** All five fields below were added in migration 0005 for BrightLocal
   *  Listings API NAP matching. Nullable for backward-compat with rows
   *  seeded before the migration; the audit endpoint guards on presence. */
  phone: string | null;
  street_address: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  /** ISO-3166-1 alpha-3 (e.g. 'USA', 'GBR'). Defaults to 'USA'. */
  country_code: string | null;
  latitude: number;
  longitude: number;
  pin_lat: number | null;
  pin_lng: number | null;
  service_radius_miles: number | null;
  industry: string | null;
  primary_color: string | null;
  logo_url: string | null;
  status: ClientStatus | null;
  monthly_price_cents: number | null;
  stripe_customer_id: string | null;
  onboarded_at: string | null;
  created_at: string | null;
};

export type TrackedKeywordRow = {
  id: string;
  client_id: string;
  keyword: string;
  is_primary: boolean | null;
  scan_frequency: ScanFrequency | null;
  created_at: string | null;
};

// Note: clients table also gains structured NAP columns in migration 0005
// (phone + street_address + city + region + postcode + country_code).
// Added there because BrightLocal Listings API requires them broken out.

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
  status: 'matched' | 'mismatch' | 'unverified';
};

export type NapAuditMissing = {
  directory: string;
  priority: 'high' | 'medium' | 'low';
};

export type NapAuditFindings = {
  citations: NapAuditCitation[];
  inconsistencies: NapAuditInconsistency[];
  missing: NapAuditMissing[];
};

export type NapAuditRow = {
  id: string;
  client_id: string;
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
