/**
 * Franchise detection for the AI Coach.
 *
 * Why: the Coach's recommendations assume the business controls its own
 * website. A franchisee does not. Five Star Painting of Austin was told to
 * "build 8 East Austin neighborhood landing pages" — on fivestarpainting.com,
 * a Neighborly corporate domain the franchisee cannot publish to
 * (2026-09-16). The advice was sound SEO and impossible to execute, which is
 * worse than no advice: it burns the operator's credibility on the call.
 *
 * What changes when this fires: web-content actions get reframed as requests
 * to the brand ("ask corporate to publish /austin/geo/east-austin/ — they
 * already run /geo/buda/ and /geo/lakeway/"), and the Coach leans on the
 * levers a franchisee genuinely owns: their own GBP, reviews, service-area
 * settings, local citations, and photos.
 *
 * Conservative, same contract as lib/metrics/tradeRelevance and
 * lib/industries/normalize: fire only on an unambiguous signal, because a
 * false positive tells a genuinely independent business it can't touch its
 * own site. A bare "<something> of <somewhere>" name is NOT enough — "House
 * of Pizza" and "Bank of Ohio" match that shape — so the generic path needs
 * the name pattern AND a corporate-domain location page.
 *
 * Pure, no I/O. Guarded by scripts/verify-franchise.ts.
 */

/** Brands seen in this book, plus the large national systems whose
 *  franchisees are the likeliest TurfMap clients. Matched as whole words on
 *  the normalised name, so "Five Star Painting of Austin" hits and "Five
 *  Star Plumbing, Heating, Cooling & Electrical" (an independent in Greer,
 *  SC) does not. */
const FRANCHISE_BRANDS: readonly string[] = [
  'certapro painters', 'five star painting', 'fresh coat painters',
  '360 painting', 'that 1 painter', 'painter bros', 'groovy hues',
  'wow 1 day painting', 'servpro', 'puroclean', 'restoration 1',
  'advantaclean', 'drymedic', 'rainbow restoration', 'paul davis',
  'roto-rooter', 'mr rooter', 'mr handyman', 'mr electric', 'aire serv',
  'benjamin franklin plumbing', 'one hour heating', 'mister sparky',
  'window genie', 'chem-dry', 'mosquito joe', 'lawn doctor', 'trugreen',
  'handyman connection', 'budget blinds', 'renewal by andersen',
  'champion windows', 'leaf home', 'dreamstyle remodeling', 'bath fitter',
  're-bath', 'kitchen tune-up', 'precision garage door', 'garage experts',
  'shelfgenie', 'closets by design', 'two men and a truck',
  'college hunks hauling junk', 'junk king', '1-800-got-junk', 'molly maid',
  'merry maids', 'the cleaning authority', 'jan-pro', 'anago',
  'stanley steemer', 'zerorez', 'pool scouts', 'sir grout', 'fibrenew',
  'victors home solutions', 'greenix', 'the window experts',
];

/** Hosts that serve many franchisees from one domain. A client whose site is
 *  a PATH on one of these cannot publish pages there. */
const KNOWN_FRANCHISE_HOSTS: readonly string[] = [
  'fivestarpainting.com', 'certapro.com', 'freshcoatpainters.com',
  '360painting.com', 'painterbros.com', 'servpro.com', 'puroclean.com',
  'restoration1.com', 'advantaclean.com', 'mrhandyman.com', 'mrrooter.com',
  'mrelectric.com', 'aireserv.com', 'benjaminfranklinplumbing.com',
  'onehourheatandair.com', 'mistersparky.com', 'windowgenie.com',
  'chemdry.com', 'mosquitojoe.com', 'lawndoctor.com', 'budgetblinds.com',
  'rainbowrestores.com', 'neighborly.com', 'twomenandatruck.com',
  'mollymaid.com', 'merrymaids.com', 'stanleysteemer.com',
];

export type FranchiseContext = {
  isFranchise: boolean;
  /** Brand the franchisee operates under, when identifiable. */
  brand: string | null;
  /** The location qualifier from a "<Brand> of <Place>" name. */
  territory: string | null;
  /** Corporate domain the client's site lives on, when it is one. */
  corporateHost: string | null;
  /** Path prefix the franchisee's pages sit under, e.g. "/austin". Null when
   *  the site is at the domain root or no website is known. */
  locationPath: string | null;
  /** Why it fired — surfaced in the prompt so the Coach can be specific. */
  signals: string[];
};

const NONE: FranchiseContext = {
  isFranchise: false, brand: null, territory: null,
  corporateHost: null, locationPath: null, signals: [],
};

function normalise(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[®™]/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch { return null; }
}

function pathOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    const seg = u.pathname.split('/').filter(Boolean);
    return seg.length > 0 ? `/${seg[0]}` : null;
  } catch { return null; }
}

/** "<Brand> of <Place>" → its two halves, or null. */
export function splitOfName(businessName: string | null | undefined): { brand: string; territory: string } | null {
  const raw = (businessName ?? '').trim();
  // Only the LAST " of " so "CertaPro Painters of Northwest Metro
  // Minneapolis, MN" splits once, at the right place.
  const m = /^(.+?)\s+of\s+(.+)$/i.exec(raw);
  if (!m) return null;
  const brand = m[1].trim();
  const territory = m[2].trim();
  if (!brand || !territory) return null;
  return { brand, territory };
}

export function detectFranchise(input: {
  businessName: string | null | undefined;
  /** gbp_signals.website_uri or client_locations website, when known. */
  websiteUri?: string | null;
}): FranchiseContext {
  const name = normalise(input.businessName);
  if (!name) return NONE;

  const signals: string[] = [];
  const host = hostOf(input.websiteUri);
  const path = pathOf(input.websiteUri);
  const corporateHost = host && KNOWN_FRANCHISE_HOSTS.includes(host) ? host : null;
  if (corporateHost) signals.push(`website is a location page on ${corporateHost}`);

  const brandHit = FRANCHISE_BRANDS.find((b) => {
    const nb = normalise(b);
    return name === nb || name.startsWith(`${nb} `) || name.includes(` ${nb} `) || name.endsWith(` ${nb}`);
  }) ?? null;
  if (brandHit) signals.push(`"${brandHit}" is a franchised brand`);

  const split = splitOfName(input.businessName);
  if (split && (brandHit || corporateHost)) {
    signals.push(`name is "<brand> of <territory>" ("${split.territory}")`);
  }

  // Fire on a known brand, or on a corporate-domain location page. The
  // "<X> of <Y>" shape alone is never enough — see the module note.
  const isFranchise = Boolean(brandHit || corporateHost);
  if (!isFranchise) return NONE;

  return {
    isFranchise: true,
    brand: brandHit ? brandHit.replace(/\b\w/g, (c) => c.toUpperCase()) : split?.brand ?? null,
    territory: split?.territory ?? null,
    corporateHost,
    locationPath: corporateHost ? path : null,
    signals,
  };
}
