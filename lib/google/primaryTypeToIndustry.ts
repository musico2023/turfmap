/**
 * Map a Google Business Profile `primaryType` (place_types enum)
 * to a TurfMap industry slug from the closed-set INDUSTRY_GROUPS
 * picker on the agency create-client form.
 *
 * Best-effort + non-authoritative — the operator still confirms via
 * the dropdown. The mapping covers the most common home-services,
 * medical, legal, food, real-estate, and automotive types that
 * Google ships; unknown values return null so the dropdown stays
 * empty and the operator picks manually.
 *
 * Why this mapping vs. relying on the enrich-on-create back-lookup:
 * the operator already explicitly picked the GBP from the
 * autocomplete; they don't want to do a second mental step picking
 * the industry from a long dropdown. Auto-suggest from the primary
 * type cuts the click count without taking control away — the
 * dropdown still wins on conflict.
 *
 * INDUSTRY_GROUPS source of truth lives in
 * components/turfmap/ClientCreateForm.tsx.
 */

const PRIMARY_TYPE_TO_INDUSTRY: Record<string, string> = {
  // ── Home services ───────────────────────────────────────────────
  plumber: 'plumbing',
  hvac_contractor: 'hvac',
  roofing_contractor: 'roofing',
  electrician: 'electrical',
  landscaper: 'landscaping',
  pest_control_service: 'pest control',
  house_cleaning_service: 'cleaning',
  cleaning_service: 'cleaning',
  garage_door_contractor: 'garage doors',
  locksmith: 'locksmith',
  pool_cleaning_service: 'pool maintenance',
  tree_care_service: 'tree care',
  appliance_repair_service: 'appliance repair',
  concrete_contractor: 'concrete',
  fence_contractor: 'fencing',
  pressure_washing_service: 'pressure washing',
  window_cleaning_service: 'window cleaning',
  painter: 'painting',
  flooring_contractor: 'flooring',
  drywall_contractor: 'drywall',

  // ── Home improvement & remodeling ───────────────────────────────
  // GBP primaryType enums for the remodeling/cabinetry verticals. Any
  // that aren't real Places types simply never match (operator picks
  // manually) — harmless. Slugs MUST equal an INDUSTRY_GROUPS option.
  general_contractor: 'general contractor',
  cabinet_store: 'cabinets',
  kitchen_remodeler: 'kitchen remodeling',
  bathroom_remodeler: 'bathroom remodeling',
  countertop_store: 'countertops',
  window_installation_service: 'windows & doors',
  door_supplier: 'windows & doors',

  // ── Medical & healthcare ────────────────────────────────────────
  doctor: 'medical',
  medical_clinic: 'medical',
  dentist: 'dental',
  dental_clinic: 'dental',
  chiropractor: 'chiropractic',
  veterinary_care: 'veterinary',
  pediatrician: 'pediatric',
  optometrist: 'optometry',
  physiotherapist: 'physical therapy',
  home_health_care_service: 'home healthcare',

  // ── Legal ───────────────────────────────────────────────────────
  lawyer: 'law firm',
  legal_services: 'law firm',
  notary_public: 'attorney',

  // ── Food & restaurant ──────────────────────────────────────────
  restaurant: 'restaurant',
  cafe: 'cafe',
  bakery: 'bakery',
  caterer: 'catering',
  catering_service: 'catering',
  pizza_restaurant: 'pizza',

  // ── Real estate ────────────────────────────────────────────────
  real_estate_agency: 'real estate',
  real_estate_agent: 'realtor',

  // ── Automotive ─────────────────────────────────────────────────
  car_repair: 'auto repair',
  auto_repair_shop: 'auto repair',
  auto_body_shop: 'auto body',
  car_wash: 'car wash',
  auto_detailing_service: 'detailing',
};

export function primaryTypeToIndustry(
  primaryType: string | null | undefined
): string | null {
  if (!primaryType) return null;
  return PRIMARY_TYPE_TO_INDUSTRY[primaryType] ?? null;
}
