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

  // ── Moving & hauling ────────────────────────────────────────────
  // (2026-07-22 — a moving company had NO industry mapping at all.)
  moving_company: 'moving',
  moving_and_storage_service: 'moving',
  mover: 'moving',
  storage: 'storage',
  self_storage_facility: 'storage',
  junk_removal_service: 'junk removal',
  garbage_collection_service: 'junk removal',

  // ── More home services (coverage sweep, 2026-07-22) ─────────────
  handyman: 'handyman',
  insulation_contractor: 'insulation',
  solar_energy_contractor: 'solar',
  siding_contractor: 'siding',
  gutter_cleaning_service: 'gutters',
  snow_removal_service: 'snow removal',
  chimney_sweep: 'chimney services',
  masonry_contractor: 'masonry',
  paving_contractor: 'paving',
  excavating_contractor: 'excavation',
  water_damage_restoration_service: 'restoration',
  fire_damage_restoration_service: 'restoration',
  carpet_cleaning_service: 'carpet cleaning',
  security_system_installer: 'security systems',

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
  towing_service: 'towing',

  // ── Beauty, fitness, pets, education, events (2026-07-22) ───────
  hair_salon: 'hair salon',
  beauty_salon: 'hair salon',
  barber_shop: 'barber',
  nail_salon: 'nail salon',
  spa: 'spa',
  day_spa: 'spa',
  massage: 'massage therapy',
  tattoo_parlor: 'tattoo',
  gym: 'gym',
  fitness_center: 'gym',
  yoga_studio: 'yoga',
  pilates_studio: 'yoga',
  martial_arts_school: 'martial arts',
  dance_school: 'dance school',
  pet_groomer: 'pet grooming',
  pet_boarding_service: 'pet boarding',
  dog_trainer: 'dog training',
  child_care_agency: 'daycare',
  day_care_center: 'daycare',
  preschool: 'preschool',
  tutoring_service: 'tutoring',
  driving_school: 'driving school',
  music_school: 'music school',
  event_planner: 'event planning',
  wedding_venue: 'wedding venue',
  banquet_hall: 'wedding venue',
  photographer: 'photography',
  wedding_photographer: 'photography',

  // ── Finance / professional (2026-07-22) ─────────────────────────
  accounting_firm: 'accounting',
  accountant: 'accounting',
  insurance_agency: 'insurance',
  mortgage_broker: 'mortgage',
  property_management_company: 'property management',

  // ── Other local services (2026-07-22) ───────────────────────────
  funeral_home: 'funeral home',
  florist: 'florist',
  hotel: 'hotel',
  bar: 'bar',
  ice_cream_shop: 'dessert shop',
  dessert_shop: 'dessert shop',
};

export function primaryTypeToIndustry(
  primaryType: string | null | undefined
): string | null {
  if (!primaryType) return null;
  return PRIMARY_TYPE_TO_INDUSTRY[primaryType] ?? null;
}
