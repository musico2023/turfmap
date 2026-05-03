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
  address: string;
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
