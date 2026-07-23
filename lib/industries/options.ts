/**
 * The closed-set industry picker options for the agency create-client
 * form (and anywhere else an operator selects an industry).
 *
 * Extracted from components/turfmap/ClientCreateForm.tsx (2026-07-22) so
 * non-React code — most importantly the verify-industry-coverage build
 * guard — can import the list without dragging in the component tree.
 *
 * INVARIANTS (enforced by scripts/verify-industry-coverage.ts):
 *   1. Every option resolves via matchIndustryKey() to an INDUSTRY_STEMS
 *      key — so keyword auto-suggestions always work for a picked
 *      industry.
 *   2. Every GBP category in lib/citations/gbp-categories.ts either
 *      resolves too, or is consciously listed in the guard's
 *      DELIBERATELY_UNMAPPED set (retail/civic categories where the
 *      literal-word fallback suggestion is the right behavior).
 *
 * Grouping note: each group loosely corresponds to a BrightLocal
 * directory profile (lib/brightlocal/directories.ts). Groups without a
 * dedicated profile (beauty, fitness, pets, …) route to the 'universal'
 * directory set by design — safe core dirs, no false Angi-style
 * recommendations.
 */

export type IndustryGroup = {
  label: string;
  options: string[];
};

export const INDUSTRY_GROUPS: IndustryGroup[] = [
  {
    label: 'Home services',
    options: [
      'plumbing',
      'hvac',
      'roofing',
      'electrical',
      'landscaping',
      'tree care',
      'pest control',
      'cleaning',
      'carpet cleaning',
      'garage doors',
      'locksmith',
      'security systems',
      'septic services',
      'pool maintenance',
      'appliance repair',
      'concrete',
      'masonry',
      'paving',
      'excavation',
      'foundation repair',
      'fencing',
      'pressure washing',
      'window cleaning',
      'painting',
      'flooring',
      'drywall',
      'insulation',
      'solar',
      'siding',
      'gutters',
      'chimney services',
      'snow removal',
      'restoration',
      'handyman',
    ],
  },
  {
    label: 'Moving & hauling',
    options: ['moving', 'junk removal', 'storage'],
  },
  {
    label: 'Home improvement & remodeling',
    options: [
      'general contractor',
      'remodeling',
      'kitchen remodeling',
      'bathroom remodeling',
      'cabinets',
      'countertops',
      'windows & doors',
    ],
  },
  {
    label: 'Medical & healthcare',
    options: [
      'medical',
      'dental',
      'chiropractic',
      'veterinary',
      'pediatric',
      'optometry',
      'physical therapy',
      'massage therapy',
      'mental health counseling',
      'home healthcare',
    ],
  },
  {
    label: 'Legal',
    options: ['law firm', 'attorney'],
  },
  {
    label: 'Food & restaurant',
    // Note: "dessert cafe" / "ice cream parlor" buyers pick 'dessert
    // shop' — the resolver routes dessert/ice-cream tokens to dessert
    // stems and the BL regex still lands the food-restaurant profile.
    options: [
      'restaurant',
      'cafe',
      'bakery',
      'dessert shop',
      'bar',
      'catering',
      'pizza',
    ],
  },
  {
    label: 'Real estate & finance',
    options: [
      'real estate',
      'realtor',
      'property management',
      'mortgage',
      'insurance',
      'accounting',
    ],
  },
  {
    label: 'Automotive',
    options: ['auto repair', 'auto body', 'car wash', 'detailing', 'towing'],
  },
  {
    label: 'Beauty & wellness',
    options: ['hair salon', 'barber', 'nail salon', 'spa', 'tattoo'],
  },
  {
    label: 'Fitness',
    options: ['gym', 'yoga', 'martial arts', 'dance school'],
  },
  {
    label: 'Pets',
    options: ['pet grooming', 'pet boarding', 'dog training'],
  },
  {
    label: 'Education & childcare',
    options: ['daycare', 'preschool', 'tutoring', 'driving school', 'music school'],
  },
  {
    label: 'Events & photography',
    options: ['event planning', 'wedding venue', 'photography'],
  },
  {
    label: 'Other local services',
    options: ['funeral home', 'florist', 'hotel'],
  },
];
