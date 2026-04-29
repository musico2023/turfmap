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

export type ScanRow = {
  id: string;
  client_id: string;
  keyword_id: string;
  scan_type: ScanType;
  grid_size: number | null;
  status: ScanStatus | null;
  turf_score: number | null;
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
