import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Check,
  Clock,
  Compass,
  Crosshair,
  Crown,
  ShieldCheck,
  Sparkles,
  Target,
  Zap,
} from 'lucide-react';
import { HeatmapGrid } from '@/components/turfmap/HeatmapGrid';
import { ScanCheckoutButton } from '@/components/marketing/ScanCheckoutButton';
import { FAQAccordion } from '@/components/marketing/FAQAccordion';
import { buildHeroCells, HERO_METRICS } from '@/components/marketing/heroSeed';
import {
  finalPriceCents,
  formatUsd,
  lookupCoupon,
  type CouponDescriptor,
} from '@/lib/coupons/knownCoupons';
import { getServerSupabase } from '@/lib/supabase/server';
import { getTurfScoreBand } from '@/lib/metrics/turfScoreBands';
import type { ProspectRow } from '@/lib/supabase/types';

/**
 * CRM warm-reactivation landing page (/freescan).
 *
 * Sister page to /yourmap (cold-email cohort). /yourmap sells the
 * $49 TurfScan to operators who've never heard of us. /freescan
 * gives the TurfScan AWAY ($0 via the VIP 100%-off coupon) to
 * operators who previously filled out a Fourdots booking form but
 * didn't close — the warm-reactivation cohort. The hard upsell on
 * this cohort is the $197 Visibility Audit, fired as Stage 2 email
 * after the recipient engages with their free scan.
 *
 * Anthony hand-sends Stage 1 emails containing a personalized link:
 *   /freescan?prospect_id=abc123xyz&coupon=VIP&utm_*=...
 * The page looks up the prospect row, renders the warm-cohort
 * copy (eyebrow, pricing card, CTA bridge line, button), and pre-
 * applies VIP at Stripe checkout for a $0 charge.
 *
 * Design parity with /yourmap is intentional. Most of this file is
 * a clone of app/yourmap/page.tsx with surgical changes:
 *   - DEFAULT_COUPON / UTM defaults switched to VIP / crm_reactivation
 *   - Eyebrow says "FREE FOR FOURDOTS BUYER LIST"
 *   - CTA labels say "Run my free TurfScan" not "Get my $X TurfScan"
 *   - Bridge line says "Free unlocks…" not "$49 unlocks…"
 *   - Worst/best case copy reframed around $0
 * When you change copy on /yourmap, audit this file for the same
 * change (and vice versa).
 *
 * URL contract:
 *   ?prospect_id=<10-char nanoid>     — lookup key for prospects
 *   ?coupon=VIP                    — 100%-off coupon, auto-applied
 *   ?utm_source=crm_reactivation      — default if absent
 *   ?utm_medium=warm_email            — default if absent
 *   ?utm_campaign=q2_2026             — campaign name; default if absent
 */

// Default UTM values when the warm-cohort URL omits them. Lets
// Anthony paste a bare /freescan?prospect_id=... and still get
// clean attribution.
const DEFAULT_UTM_SOURCE = 'crm_reactivation';
const DEFAULT_UTM_MEDIUM = 'warm_email';
const DEFAULT_UTM_CAMPAIGN = 'q2_2026';
const DEFAULT_COUPON = 'VIP';

type ProspectPersonalization = {
  id: string;
  business_name: string;
  city: string;
  trade: string;
  preview_score: number;
  band: string;
  invisibility_count: number;
  top_competitor_name: string | null;
  top_competitor_share_pct: number | null;
};

/** Look up the prospect server-side (direct DB query, not an HTTP
 *  hit to /api/prospect/[id] — same JS process, no need for the
 *  network roundtrip). Returns:
 *    - { kind: 'found', data } when the row exists + isn't converted
 *    - { kind: 'converted', convertedAt } when already converted
 *    - { kind: 'not_found' } when missing OR no id supplied
 *  Also stamps view metrics on the row when found (best effort). */
async function loadProspect(
  prospectId: string | null
): Promise<
  | { kind: 'found'; data: ProspectPersonalization }
  | { kind: 'converted'; convertedAt: string }
  | { kind: 'not_found' }
> {
  if (!prospectId) return { kind: 'not_found' };
  const supabase = getServerSupabase();
  const { data: prospect } = await supabase
    .from('prospects')
    .select('*')
    .eq('id', prospectId)
    .maybeSingle<ProspectRow>();
  if (!prospect) return { kind: 'not_found' };
  if (prospect.converted_at) {
    return { kind: 'converted', convertedAt: prospect.converted_at };
  }
  // Best-effort view stamp. Don't await — page render shouldn't
  // block on this write.
  void (async () => {
    try {
      await supabase
        .from('prospects')
        .update({
          view_count: prospect.view_count + 1,
          page_viewed_at: prospect.page_viewed_at ?? new Date().toISOString(),
        })
        .eq('id', prospectId);
    } catch {
      // swallow — view metrics aren't critical
    }
  })();
  return {
    kind: 'found',
    data: {
      id: prospect.id,
      business_name: prospect.business_name,
      city: prospect.city,
      trade: prospect.trade,
      preview_score: prospect.preview_score,
      band: getTurfScoreBand(prospect.preview_score).label,
      invisibility_count: prospect.invisibility_count,
      top_competitor_name: prospect.top_competitor_name,
      top_competitor_share_pct: prospect.top_competitor_share_pct,
    },
  };
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{
    [key: string]: string | string[] | undefined;
  }>;
}): Promise<Metadata> {
  const params = await searchParams;
  const prospectId = pickFirst(params.prospect_id);
  const lookup = await loadProspect(prospectId);
  const robots = { index: false, follow: false };
  if (lookup.kind === 'found') {
    return {
      title: `Your free TurfScan — TurfScore ${lookup.data.preview_score} · TurfMap`,
      description: `We ran a preview scan of ${lookup.data.business_name}. Your TurfScore is ${lookup.data.preview_score}. Full 81-point breakdown is free — buyer-list rate, no card required.`,
      robots,
    };
  }
  return {
    title: 'Your free TurfScan · TurfMap',
    description:
      'Free TurfScan for the Fourdots buyer list. 81 grid points, real Google searches, AI Coach Fix List delivered in under a minute. No card required.',
    robots,
  };
}

export default async function FreeScanLandingPage({
  searchParams,
}: {
  searchParams: Promise<{
    [key: string]: string | string[] | undefined;
  }>;
}) {
  const params = await searchParams;
  const prospectId = pickFirst(params.prospect_id);
  const couponCode = pickFirst(params.coupon) ?? DEFAULT_COUPON;
  const utmSource = pickFirst(params.utm_source) ?? DEFAULT_UTM_SOURCE;
  const utmMedium = pickFirst(params.utm_medium) ?? DEFAULT_UTM_MEDIUM;
  const utmCampaign =
    pickFirst(params.utm_campaign) ?? DEFAULT_UTM_CAMPAIGN;
  const gclid = pickFirst(params.gclid);

  const prospectLookup = await loadProspect(prospectId);
  const personalization =
    prospectLookup.kind === 'found' ? prospectLookup.data : null;

  // Already-converted prospects skip the whole lander — they have a
  // dashboard, sending them through another buy flow would be
  // redundant. Render the small recovery state directly.
  if (prospectLookup.kind === 'converted') {
    return (
      <AlreadyConvertedState convertedAt={prospectLookup.convertedAt} />
    );
  }

  const coupon = lookupCoupon(couponCode, 'scan');
  const listCents = 9900;
  const showDiscount = coupon !== null;
  const finalCents = coupon ? finalPriceCents(coupon) : listCents;

  // Hero heatmap is shared sample data — same as /fourdots.
  const cells = buildHeroCells();
  const { reach, rank, score, band } = HERO_METRICS;

  // Hero visual title personalizes when prospect data loads,
  // otherwise falls back to the /fourdots default.
  const heroVisualTitle = personalization
    ? `Sample · ${personalization.trade}, ${personalization.city}`
    : 'Sample · Plumber, midtown';

  return (
    <div className="min-h-screen w-full text-white">
      {/* ─── HEADER ───────────────────────────────────────────────────
       *  /yourmap-specific simplification per Sprint-1 Fix 1.7: the
       *  "Existing customer?" link from /fourdots is REMOVED here.
       *  Cold-email cohort buyers don't have an existing TurfMap
       *  account by definition; the link only adds cognitive
       *  friction at the moment of conversion. /fourdots keeps the
       *  link since FOURDOTS50 traffic includes some returning
       *  buyers from Anthony's parent-site popup. */}
      <header
        className="border-b px-6 md:px-10 py-4 flex items-center"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <Link href="/" className="flex items-center gap-2.5 group">
          <span
            className="w-7 h-7 rounded-md flex items-center justify-center"
            style={{ background: 'var(--color-lime)' }}
          >
            <Crosshair size={16} strokeWidth={2.25} className="text-black" />
          </span>
          <span className="font-display text-base md:text-lg font-bold tracking-tight">
            TurfMap
            <span
              className="text-[9px] align-top ml-0.5"
              style={{ color: 'var(--color-lime)' }}
            >
              ™
            </span>
          </span>
        </Link>
      </header>

      {/* ─── HERO ───────────────────────────────────────────────────── */}
      <section className="relative px-6 md:px-10 pt-12 md:pt-16 pb-12 overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 60% 50% at 75% 40%, #c5ff3a14 0%, transparent 60%)',
          }}
        />

        <div className="relative max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-start">
          <div className="lg:col-span-7">
            {/* Eyebrow — warm-reactivation framing. Differs from
             *  /yourmap's "delivered from outreach team" language;
             *  this cohort already knows Fourdots, so we lead with
             *  the gift framing instead of an introduction. */}
            <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-5 flex items-center gap-2 flex-wrap">
              <span style={{ color: 'var(--color-lime)' }}>●</span>
              <span style={{ color: 'var(--color-lime)' }}>
                Your TurfMap preview
              </span>
            </div>

            {/* H1 — three-tier weight hierarchy per Sprint-1 Fix 1.3.
             *  The buyer's business name is the most personally-
             *  relevant token on the page; bolding ONLY that span
             *  while leaving "We already mapped" at regular weight
             *  visually anchors recognition without making the rest
             *  of the H1 feel shouty. The italic tail keeps the
             *  rhetorical beat ("here's what we found.") tethered
             *  to the rest of the line.
             *  Parent has no font-bold so individual span weights
             *  apply; would otherwise be overridden. */}
            <h1 className="font-display text-4xl md:text-5xl lg:text-6xl leading-[1.04] tracking-tight mb-4 text-zinc-100">
              {personalization ? (
                <>
                  <span className="font-normal text-zinc-300">
                    We already mapped{' '}
                  </span>
                  <span className="font-bold text-white">
                    {personalization.business_name}
                  </span>
                  <span className="font-normal text-zinc-300">.</span>{' '}
                  <em className="font-semibold">
                    Here&rsquo;s what we found.
                  </em>
                </>
              ) : (
                <>
                  <span className="font-normal text-zinc-300">
                    We already ran your preview scan.
                  </span>{' '}
                  <em className="font-semibold">
                    Here&rsquo;s what we found.
                  </em>
                </>
              )}
            </h1>

            <p className="font-display text-lg md:text-xl text-zinc-300 italic leading-snug mb-5 max-w-xl">
              The full Google Maps audit you should run before spending
              another dollar on local SEO.
            </p>

            {/* Body paragraph — Sprint-2 Fix 4 streamlined to a
             *  one-sentence framer. The buyer's actual data
             *  (score, invisibility count, top competitor) now
             *  lives in dedicated cards below, so this para's job
             *  is just to introduce them and get out of the way. */}
            <p className="text-zinc-300 text-base md:text-lg leading-relaxed max-w-xl mb-6">
              {personalization ? (
                <>
                  We ran an 81-point geo-grid preview of{' '}
                  {personalization.business_name}&rsquo;s{' '}
                  {personalization.city} service area. Then you get
                  three specific actions &mdash; the ones with the
                  highest impact, in priority order. The full scan is
                  yours — no charge, no card. Your VIP coupon is
                  pre-applied at checkout.
                </>
              ) : (
                <>
                  We ran a preview of your service area on TurfMap.
                  Then you get three specific actions &mdash; the ones
                  with the highest impact, in priority order. The full
                  scan is yours — no charge, no card. Your VIP coupon
                  is pre-applied at checkout.
                </>
              )}
            </p>

            {/* Your Preview Score card — Sprint-2 Fix 2. Primary
             *  visual anchor of the hero. Renders nothing when the
             *  fallback path is active (no personalization data); a
             *  generic stand-in would dilute the "we already ran
             *  your scan" framing. */}
            {personalization && (
              <YourPreviewScoreCard
                score={personalization.preview_score}
                band={personalization.band}
              />
            )}

            {/* The Competition card — Sprint-2 Fix 3. Warm-toned
             *  accent (uses the existing palette's --color-warn /
             *  orange channel) so it visually differentiates from
             *  the lime YOUR PREVIEW SCORE card without alarmism.
             *  Renders only when we have competitor data. */}
            {personalization &&
              personalization.top_competitor_name &&
              personalization.top_competitor_share_pct != null && (
                <TheCompetitionCard
                  competitorName={personalization.top_competitor_name}
                  sharePct={personalization.top_competitor_share_pct}
                  city={personalization.city}
                />
              )}

            <PricePanel
              listCents={listCents}
              finalCents={finalCents}
              coupon={coupon}
              couponCode={couponCode}
              utmSource={utmSource}
              utmMedium={utmMedium}
              utmCampaign={utmCampaign}
              gclid={gclid}
              prospectId={prospectId}
            />

            <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-zinc-500 font-mono">
              <span className="flex items-center gap-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: 'var(--color-lime)' }}
                />
                Delivered in under a minute
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: 'var(--color-lime)' }}
                />
                24-hour refund window
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: 'var(--color-lime)' }}
                />
                81 real searches
              </span>
            </div>
          </div>

          {/* Right: sample heatmap + score row.
           *  Sprint-2 Fix 1 made this column visually SUBORDINATE
           *  to the left column. Per spec:
           *    - slightly smaller scale (opacity-reduced shell +
           *      tighter container)
           *    - slightly muted color treatment (lower-opacity
           *      score cards via the `subdued` flag)
           *    - keeps current EXAMPLE badge + caption stack
           *  The left column is now the buyer-data anchor
           *  (YourPreviewScoreCard + TheCompetitionCard); this
           *  right column shows what the product looks like, not
           *  what the buyer's data is.
           */}
          <div className="lg:col-span-5 opacity-90">
            {/* ANONYMIZED-EXAMPLE pill — solid lime fill so it reads
             *  at a glance even when the rest of the card is being
             *  scanned. Carries enough visual weight to override
             *  the buyer's first instinct ("is that my data?"). */}
            <div className="mb-2 flex">
              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[9px] uppercase tracking-[0.16em] font-bold"
                style={{
                  background: 'var(--color-lime)',
                  color: '#000',
                }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: '#000' }}
                />
                Anonymized example — not your data
              </span>
            </div>
            <div
              className="border rounded-lg p-5 relative"
              style={{
                background: 'var(--color-card)',
                borderColor: 'var(--color-border-bright)',
                boxShadow: '0 0 60px #c5ff3a10',
              }}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
                  {heroVisualTitle}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500">
                  <span
                    className="w-1.5 h-1.5 rounded-full animate-pulse"
                    style={{ background: 'var(--color-lime)' }}
                  />
                  LIVE
                </div>
              </div>
              <HeatmapGrid cells={cells} />
              {/* Caption sits IMMEDIATELY adjacent to the heatmap
               *  visual (inside the card, between heatmap + score
               *  row) per Sprint-1 Fix 1.1. Bold lead clause kills
               *  any "wait, is that my data?" ambiguity on first
               *  glance. */}
              <p className="text-[11px] text-zinc-400 mt-3 mb-4 leading-relaxed text-center">
                <strong className="text-zinc-200">
                  This is a sample heatmap, not your data.
                </strong>{' '}
                Your full TurfScan reveals your actual 81-cell heatmap,
                your specific TurfScore, and your competitor positions.
              </p>
              {/* Score cards — distinct cards (not just text) with
               *  larger values per Fix 1.4. Buyer should read this
               *  row as "the three numbers your full scan reveals,"
               *  hence the heavier visual treatment. */}
              <div className="grid grid-cols-3 gap-3 md:gap-4">
                <ScoreReadout label="TurfReach™" value={`${reach}%`} />
                <ScoreReadout
                  label="TurfRank™"
                  value={`${rank.toFixed(1)} / 3`}
                />
                <ScoreReadout
                  label="TurfScore™"
                  value={String(score)}
                  highlight
                  bandLabel={band}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── WHAT YOU'LL GET (mirrors /fourdots Section 03) ─────────── */}
      <section
        className="px-6 md:px-10 py-16 border-t"
        style={{
          borderColor: 'var(--color-border)',
          background: 'var(--color-card)',
        }}
      >
        <div className="max-w-5xl mx-auto">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3">
            <span style={{ color: 'var(--color-lime)' }}>·</span>{' '}
            What you walk away with
          </div>
          <h2 className="font-display text-3xl md:text-4xl font-bold leading-[1.05] tracking-tight mb-3 max-w-3xl">
            A prioritized fix list. <em>In plain English.</em>
          </h2>
          <p className="text-zinc-400 text-base md:text-lg leading-relaxed max-w-2xl mb-8">
            Three prioritized actions specific to your business and category,
            written by our AI Coach from your real audit data — not generic
            SEO advice.{' '}
            <strong className="font-semibold text-zinc-200">
              You walk away knowing what to fix, in what order.
            </strong>
          </p>

          <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3 flex items-center gap-2">
            <Sparkles size={11} style={{ color: 'var(--color-lime)' }} />
            <span style={{ color: 'var(--color-lime)' }}>The fix list</span>
            <span className="text-zinc-600">·</span>
            <span>What you&rsquo;ll actually do</span>
          </div>
          <div
            className="border rounded-lg p-5 md:p-7"
            style={{
              background: '#0a0f04',
              borderColor: 'var(--color-border-bright)',
            }}
          >
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
              {(() => {
                // Sprint-1 Fix 2.1 — dynamic trade reference in
                // the second card. When the prospect's trade is
                // known, surface it in the "For this {trade}
                // contractor:" preamble so the personalization
                // illusion holds for HVAC / Roofing / Plumbing
                // etc. Falls back to "operator" when no
                // personalization data is loaded.
                const tradeContractor = personalization
                  ? `${personalization.trade.toLowerCase()} contractor`
                  : 'operator';
                return [
                  {
                    priority: 'HIGH',
                    title:
                      'Verify your Apple Maps listing — currently unverified',
                    body: 'iPhone users searching from the northern half of your service area get directed to a verified competitor. Verifying the listing is a 5-minute fix that immediately reclaims those cells.',
                  },
                  {
                    priority: 'HIGH',
                    title: 'Claim 8 missing industry directories',
                    body: `For this ${tradeContractor}: Angi, HomeAdvisor, Thumbtack, BBB, and 4 others — all absent. The exact list is industry-specific. Citation authority on the directories Google cross-references is the fastest TurfReach lever.`,
                  },
                  {
                    priority: 'MEDIUM',
                    title: 'Normalize address format on Bing, Yelp, MapQuest',
                    body: 'Three directories show abbreviated or malformed address strings. Fixing NAP consistency reduces noise that suppresses trust signals.',
                  },
                ];
              })().map((a, i) => (
                <div
                  key={i}
                  className="border rounded-md p-4 md:p-5"
                  style={{
                    background: 'var(--color-bg)',
                    borderColor: 'var(--color-border)',
                  }}
                >
                  <div className="flex items-center justify-between mb-2.5">
                    <span
                      className="text-[9px] font-mono uppercase font-bold tracking-[0.18em] px-1.5 py-0.5 rounded"
                      style={{
                        background:
                          a.priority === 'HIGH' ? '#1a2010' : '#221a08',
                        color:
                          a.priority === 'HIGH'
                            ? 'var(--color-lime)'
                            : '#f5b651',
                        border: `1px solid ${
                          a.priority === 'HIGH'
                            ? 'var(--color-border-bright)'
                            : '#3a2a0a'
                        }`,
                      }}
                    >
                      {a.priority}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-600">
                      #{i + 1}
                    </span>
                  </div>
                  <div className="font-display font-bold text-sm md:text-base leading-snug mb-2 text-zinc-100">
                    {a.title}
                  </div>
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    {a.body}
                  </p>
                </div>
              ))}
            </div>

            <div
              className="mt-5 pt-4 border-t flex items-start gap-2.5"
              style={{ borderColor: 'var(--color-border)' }}
            >
              <Zap
                size={13}
                strokeWidth={2.5}
                className="flex-shrink-0 mt-0.5"
                style={{ color: 'var(--color-lime)' }}
              />
              <div className="text-xs leading-relaxed text-zinc-400">
                <span
                  className="font-semibold"
                  style={{ color: 'var(--color-lime)' }}
                >
                  Grounded in real data.
                </span>{' '}
                Every recommendation cites the specific directories
                you&rsquo;re missing from, the inconsistencies in your
                business listing, and the moves that map to your industry.
                No generic SEO advice — real audit findings, prioritized.
              </div>
            </div>

            <p className="text-xs text-zinc-600 font-mono mt-3">
              Sample output. Your actions will be specific to your business,
              category, and what your map reveals.
            </p>
          </div>
        </div>
      </section>

      {/* ─── HOW WE MEASURE ─────────────────────────────────────────── */}
      <section className="px-6 md:px-10 py-16">
        <div className="max-w-5xl mx-auto">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3">
            <span style={{ color: 'var(--color-lime)' }}>·</span>{' '}
            How we measure
          </div>
          <h2 className="font-display text-3xl md:text-4xl font-bold leading-[1.05] tracking-tight mb-3 max-w-3xl">
            Three numbers, anchored in your map.
          </h2>
          <p className="text-zinc-400 text-base leading-relaxed max-w-2xl mb-8">
            Every fix list is anchored in three computed metrics. They map
            directly to specific actions — that&rsquo;s why the
            recommendations above are prioritized the way they are.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-5">
            <ScoreCardCompact
              icon={Compass}
              name="TurfReach"
              tagline="How much of your area you cover"
              range="0 – 100%"
              example="At 35%, two-thirds of nearby searchers don't see you."
            />
            <ScoreCardCompact
              icon={Crown}
              name="TurfRank"
              tagline="Where you sit when you do appear"
              range="1.0 – 3.0"
              example="At 1.4, you're scraping the bottom of the pack."
            />
            <ScoreCardCompact
              icon={Target}
              name="TurfScore"
              tagline="Composite visibility"
              range="0 – 100"
              example="Most pre-optimization clients land 30–55."
              highlight
            />
          </div>
        </div>
      </section>

      {/* ─── WHAT'S IN TURFSCAN ─────────────────────────────────────── */}
      <section
        className="px-6 md:px-10 py-12 border-t"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-3xl mx-auto">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-4">
            <span style={{ color: 'var(--color-lime)' }}>·</span>{' '}
            What&rsquo;s in TurfScan
          </div>
          <ul className="space-y-3">
            {[
              '81-point geo-grid scan, one keyword',
              'TurfReach + TurfRank + TurfScore',
              'Citation check across the directories that matter for your trade',
              'AI Coach: top 3 strategic recommendations, grounded in your real audit data',
              'Branded PDF report you can keep or share',
              'Delivered in under a minute',
            ].map((line) => (
              <li
                key={line}
                className="flex items-start gap-3 text-sm md:text-base text-zinc-200 leading-relaxed"
              >
                <Check
                  size={16}
                  strokeWidth={2.5}
                  className="flex-shrink-0 mt-0.5"
                  style={{ color: 'var(--color-lime)' }}
                />
                <span>{line}</span>
              </li>
            ))}
          </ul>

          <div
            className="mt-5 flex items-start gap-2.5 text-sm leading-relaxed"
            style={{ color: 'var(--color-lime)' }}
          >
            <Sparkles
              size={15}
              strokeWidth={2.5}
              className="flex-shrink-0 mt-0.5"
            />
            <span>
              <span className="font-semibold">
                + 30 days of TurfMap Pulse, free
              </span>
              <span className="text-zinc-500">
                {' '}— offered on your order-confirmation page. Cancel anytime
                before day 31 to pay nothing.
              </span>
            </span>
          </div>
        </div>
      </section>

      {/* ─── TRUST STRIP ────────────────────────────────────────────── */}
      <section
        className="px-6 md:px-10 py-8 border-y"
        style={{
          borderColor: 'var(--color-border)',
          background: 'var(--color-card)',
        }}
      >
        <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-8">
          <TrustItem icon={ShieldCheck} label="Refund window">
            Full refund within 24h if your scan hasn&rsquo;t been delivered.
          </TrustItem>
          <TrustItem icon={Clock} label="Delivery">
            Scan completes in &lt; 1 min. AI Coach fix list lands in your
            inbox alongside your map.
          </TrustItem>
          <TrustItem icon={Sparkles} label="Built by operators">
            Fourdots Digital uses TurfMap on its own clients every day.
          </TrustItem>
        </div>
      </section>

      {/* ─── FAQ — five items, with cold-email-specific question at top ── */}
      <section className="px-6 md:px-10 py-16">
        <div className="max-w-3xl mx-auto">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3">
            <span style={{ color: 'var(--color-lime)' }}>·</span>{' '}
            Common questions
          </div>
          <h2 className="font-display text-2xl md:text-3xl font-bold leading-tight tracking-tight mb-6 max-w-xl">
            Things people ask before <em>they buy.</em>
          </h2>
          {/* "How did you get my information?" leads — handles the
           *  cold-outreach trust objection up front. FAQAccordion
           *  auto-expands the first item. */}
          <FAQAccordion
            items={[
              {
                // Warm-cohort framing. Replaces the cold-email
                // "How did you get my information?" Q with the
                // gift-explanation per campaign brief Fix 2.3. These
                // recipients already know who Fourdots is — they
                // filled out a booking form in the past.
                q: 'Why is this free for me?',
                a: (
                  <>
                    You filled out a booking form on Fourdots in the
                    past, and we kept your details on file because
                    you&rsquo;re exactly the kind of operator I built
                    TurfMap for. We ran a preview scan on your business
                    this week, and I&rsquo;d like to give you the full
                    TurfScan on the house. No card required, no upsell
                    at the door. Just the data.
                  </>
                ),
              },
              {
                q: 'What if I find out my visibility is bad?',
                a: (
                  <>
                    Visibility problems are fixable. Every TurfScan ends
                    with the AI Coach Fix List — the top three actions to
                    fix in priority order, specific to your business and
                    category. Most buyers walk away with a clear plan they
                    can act on in under an hour, or hand off to a
                    freelancer or team member.
                  </>
                ),
              },
              {
                q: 'How is this different from just Googling myself?',
                a: (
                  <>
                    Google personalizes local results by your physical
                    location. From your office, you&rsquo;ll always see
                    yourself near the top — that&rsquo;s not proof you
                    rank well, it&rsquo;s proof Google knows where you
                    are. TurfScan checks 81 different points across your
                    service area to show you what customers across town
                    actually see, not what you see from your desk.
                  </>
                ),
              },
              {
                q: 'How long does it take to receive my TurfMap?',
                a: (
                  <>
                    The scan itself finishes in under a minute — we run
                    all 81 queries in parallel against Google&rsquo;s
                    local-pack feed. After you fill in your business
                    details on the order form, you&rsquo;ll get an email
                    with a link to your map and your AI Coach fix list.
                  </>
                ),
              },
              {
                q: 'What keyword should I pick?',
                a: (
                  <>
                    We pre-fill the keyword with your trade
                    (e.g. <code>plumber</code>) — the same short term
                    we used for the preview scan. Trade-only keywords
                    give the cleanest geo-grid: each of the 81 points
                    is anchored to a real lat/lon around your service
                    area, and the trade keyword stays the same across
                    all of them so the result is &ldquo;where do I
                    show up for this trade as customers move around
                    the map?&rdquo; You can override the pre-fill if
                    you want a more specific term — just don&rsquo;t
                    include your city in the keyword (the grid points
                    already cover your service area).
                  </>
                ),
              },
            ]}
          />
        </div>
      </section>

      {/* ─── CLOSING CTA ────────────────────────────────────────────── */}
      <section className="px-6 md:px-10 pb-10">
        <div className="max-w-3xl mx-auto">
          <div
            className="rounded-lg p-7 md:p-9 border text-center"
            style={{
              background: 'var(--color-card-glow)',
              borderColor: 'var(--color-border-bright)',
              boxShadow: '0 0 40px #c5ff3a14',
            }}
          >
            <div className="font-display text-2xl md:text-3xl font-bold mb-3">
              Ready to see your map?
            </div>
            <p className="text-sm md:text-base text-zinc-300 mb-1 max-w-md mx-auto leading-relaxed">
              <strong className="font-semibold text-zinc-100">
                Worst case:
              </strong>{' '}
              this scan confirms what you suspect.
            </p>
            <p className="text-sm md:text-base text-zinc-300 mb-3 max-w-md mx-auto leading-relaxed">
              <strong className="font-semibold text-zinc-100">
                Best case:
              </strong>{' '}
              one fix pays you back ten times over.
            </p>
            <p className="text-xs md:text-sm text-zinc-500 mb-6 max-w-md mx-auto leading-relaxed">
              {showDiscount && coupon && finalCents === 0 ? (
                <>
                  Free TurfScan with{' '}
                  <span className="font-mono text-zinc-300">
                    {coupon.code}
                  </span>{' '}
                  applied at checkout. No card required, no subscription.
                </>
              ) : showDiscount && coupon ? (
                <>
                  {formatUsd(finalCents)} TurfScan with{' '}
                  <span className="font-mono text-zinc-300">
                    {coupon.code}
                  </span>{' '}
                  applied at checkout. One-time, no subscription.
                </>
              ) : (
                <>
                  {formatUsd(finalCents)} TurfScan. One-time, no subscription.
                </>
              )}
            </p>
            <ScanCheckoutButton
              coupon={couponCode}
              utmSource={utmSource}
              utmMedium={utmMedium}
              utmCampaign={utmCampaign}
              gclid={gclid}
              prospectId={prospectId}
              label={
                finalCents === 0
                  ? 'Run my free TurfScan'
                  : `Get my ${formatUsd(finalCents)} TurfScan`
              }
              centered
            />
          </div>

          <p className="mt-6 text-xs text-zinc-600 text-center leading-relaxed">
            Want a 90-day Roadmap built around your map?{' '}
            <a
              href="https://www.turfmap.ai/#section-04"
              className="text-zinc-400 hover:text-zinc-200 transition-colors underline-offset-2 hover:underline"
            >
              See our Visibility Audit options →
            </a>
          </p>
        </div>
      </section>

      {/* ─── FOOTER ─────────────────────────────────────────────────── */}
      <footer
        className="border-t px-6 md:px-10 py-6 text-xs text-zinc-600"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <span>
            TurfMap™ · Proprietary technology of{' '}
            <a
              href="https://fourdots.io"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Fourdots Digital
            </a>
          </span>
          <span className="flex items-center gap-4">
            <Link
              href="/#privacy"
              className="hover:text-zinc-400 transition-colors"
            >
              Privacy
            </Link>
            <Link
              href="/#terms"
              className="hover:text-zinc-400 transition-colors"
            >
              Terms
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}

// ─── Already-converted state ────────────────────────────────────────────
//
// Renders when /api/prospect/[id] would return 410. Buyer is past
// the cold-email funnel — they have a dashboard already, sending
// them through another buy flow would create duplicate records.
// Two affordances: sign in (existing customer) or run a new scan
// on a different keyword (different SKU, different lander).

function AlreadyConvertedState({ convertedAt }: { convertedAt: string }) {
  const dateStr = new Date(convertedAt).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return (
    <div className="min-h-screen w-full text-white">
      <header
        className="border-b px-6 md:px-10 py-4 flex items-center justify-between"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <Link href="/" className="flex items-center gap-2.5 group">
          <span
            className="w-7 h-7 rounded-md flex items-center justify-center"
            style={{ background: 'var(--color-lime)' }}
          >
            <Crosshair size={16} strokeWidth={2.25} className="text-black" />
          </span>
          <span className="font-display text-base md:text-lg font-bold tracking-tight">
            TurfMap
            <span
              className="text-[9px] align-top ml-0.5"
              style={{ color: 'var(--color-lime)' }}
            >
              ™
            </span>
          </span>
        </Link>
      </header>

      <section className="px-6 md:px-10 py-24">
        <div className="max-w-2xl mx-auto text-center">
          <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3">
            <span style={{ color: 'var(--color-lime)' }}>·</span>{' '}
            Already done
          </div>
          <h1 className="font-display text-3xl md:text-4xl font-bold leading-[1.05] tracking-tight mb-4">
            You&rsquo;ve already run your full TurfMap scan.
          </h1>
          <p className="text-zinc-300 text-base md:text-lg leading-relaxed mb-3">
            Your scan was completed on <strong>{dateStr}</strong>. Your AI
            Coach Fix List was delivered to your inbox.
          </p>
          <p className="text-zinc-400 text-sm md:text-base leading-relaxed mb-8">
            To view your dashboard, sign in. To run a fresh scan on a
            different keyword, run a new scan.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/login"
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-md text-sm font-semibold border transition-colors hover:bg-white/5"
              style={{
                borderColor: 'var(--color-border-bright)',
                color: '#e4e4e7',
              }}
            >
              Sign in to my dashboard
            </Link>
            <Link
              href="/fourdots"
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-md text-sm font-semibold transition-colors"
              style={{
                background: 'var(--color-lime)',
                color: '#000',
              }}
            >
              Run a new scan →
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

// ─── Helpers (clones of /fourdots — see header note about future shell refactor) ──

function PricePanel({
  listCents,
  finalCents,
  coupon,
  couponCode,
  utmSource,
  utmMedium,
  utmCampaign,
  gclid,
  prospectId,
}: {
  listCents: number;
  finalCents: number;
  coupon: CouponDescriptor | null;
  couponCode: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  gclid: string | null;
  prospectId: string | null;
}) {
  const showDiscount = coupon !== null;
  return (
    <div
      className="rounded-lg p-5 md:p-6 border max-w-xl"
      style={{
        background: showDiscount
          ? 'var(--color-card-glow)'
          : 'var(--color-card)',
        borderColor: showDiscount
          ? 'var(--color-border-bright)'
          : 'var(--color-border)',
        boxShadow: showDiscount ? '0 0 30px #c5ff3a14' : undefined,
      }}
    >
      {/* Bridge line — warm-cohort variant. /yourmap leads with
       *  the discounted price ("$49 unlocks…") for cold-email
       *  buyers who are price-sensitive. /freescan reframes around
       *  "Free unlocks:" because the gift is the point — the price
       *  number isn't doing rhetorical work here. The three
       *  middle-dot-separated phrases below stay identical. */}
      <p className="mb-4 pb-4 border-b text-xs md:text-sm text-zinc-300 leading-relaxed"
         style={{ borderColor: 'var(--color-border)' }}
      >
        <strong className="text-zinc-100">
          {finalCents === 0 ? 'Free' : formatUsd(finalCents)} unlocks:
        </strong>{' '}
        full 81-cell heatmap{' '}
        <span className="text-zinc-600">·</span>{' '}
        AI Coach Fix List{' '}
        <span className="text-zinc-600">·</span>{' '}
        top 3 fixes
      </p>
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-5">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-2">
            TurfScan
          </div>
          <div className="flex items-baseline gap-3 flex-wrap">
            {/* Fix 1.5 — list price drops to font-normal so the
             *  discounted price dominates visually. Strikethrough
             *  + zinc-600 carries the "this was the price" framing
             *  without the eye lingering on the bigger number. */}
            {showDiscount && (
              <span className="font-display text-2xl md:text-3xl text-zinc-600 line-through font-normal">
                {formatUsd(listCents)}
              </span>
            )}
            <span
              className="font-display text-4xl md:text-5xl font-bold"
              style={{
                color: showDiscount ? 'var(--color-lime)' : '#ffffff',
              }}
            >
              {finalCents === 0 ? 'FREE' : formatUsd(finalCents)}
            </span>
            <span className="text-xs text-zinc-500 font-mono">one-time</span>
          </div>
          {showDiscount && coupon && (
            <p className="text-xs text-zinc-400 mt-2">
              <span className="font-mono text-zinc-200">{coupon.code}</span>{' '}
              applied at checkout —{' '}
              {finalCents === 0 ? 'no card required' : 'no manual code needed'}.
            </p>
          )}
        </div>
        <ScanCheckoutButton
          coupon={couponCode}
          utmSource={utmSource}
          utmMedium={utmMedium}
          utmCampaign={utmCampaign}
          gclid={gclid}
          prospectId={prospectId}
          label={
            finalCents === 0
              ? 'Run my free TurfScan'
              : `Get my ${formatUsd(finalCents)} TurfScan`
          }
        />
      </div>
    </div>
  );
}

/**
 * Score readout — distinct card per metric per Sprint-1 Fix 1.4.
 * Each card has a subtle border + tinted bg so the row reads as
 * "three numbers your full scan reveals" instead of caption text
 * under the heatmap. The TurfScore card carries an extra lime
 * accent (highlight) since it's the headline metric.
 *
 * Numeric value is now ~2× the previous size (text-xl → text-2xl/3xl)
 * to compete with the H1 weight on the left and read at a glance
 * on mobile. Band label sits beneath in small mono.
 */
function ScoreReadout({
  label,
  value,
  highlight = false,
  bandLabel,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  bandLabel?: string;
}) {
  return (
    <div
      className="rounded-md px-2.5 py-3 flex flex-col items-center text-center"
      style={{
        background: highlight ? '#0d130a' : 'var(--color-bg)',
        border: `1px solid ${
          highlight ? 'var(--color-border-bright)' : 'var(--color-border)'
        }`,
      }}
    >
      <div className="text-[10px] tracking-[0.04em] text-zinc-500 font-mono font-semibold mb-1.5">
        {label}
      </div>
      <div
        className="font-display font-bold text-2xl md:text-3xl leading-none"
        style={{ color: highlight ? 'var(--color-lime)' : '#f4f4f5' }}
      >
        {value}
      </div>
      {bandLabel && (
        <div
          className="text-[9px] font-mono uppercase tracking-wider mt-1.5"
          style={{ color: 'var(--color-lime)' }}
        >
          {bandLabel}
        </div>
      )}
    </div>
  );
}

function ScoreCardCompact({
  icon: Icon,
  name,
  tagline,
  range,
  example,
  highlight = false,
}: {
  icon: typeof Compass;
  name: string;
  tagline: string;
  range: string;
  example: string;
  highlight?: boolean;
}) {
  return (
    <div
      className="border rounded-lg p-5 flex flex-col"
      style={{
        background: highlight ? 'var(--color-card-glow)' : 'var(--color-card)',
        borderColor: highlight
          ? 'var(--color-border-bright)'
          : 'var(--color-border)',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <Icon size={18} className="text-zinc-500" />
        <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-600">
          {range}
        </span>
      </div>
      <div className="font-display text-xl md:text-2xl font-bold mb-1">
        {name}
        <span
          className="text-xs align-top ml-0.5"
          style={{ color: 'var(--color-lime)' }}
        >
          ™
        </span>
      </div>
      <div className="text-xs text-zinc-400 mb-3">{tagline}</div>
      <p className="text-sm text-zinc-300 leading-relaxed mt-auto">
        <span className="text-[9px] font-mono uppercase tracking-[0.18em] text-zinc-500 mr-2">
          E.g.
        </span>
        {example}
      </p>
    </div>
  );
}

function TrustItem({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof ShieldCheck;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Icon size={14} style={{ color: 'var(--color-lime)' }} />
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
          {label}
        </div>
      </div>
      <p className="text-sm text-zinc-400 leading-relaxed">{children}</p>
    </div>
  );
}

function pickFirst(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

// ─── Sprint-2 cards: Your Preview Score + The Competition ──────────
//
// Both cards live in the left column of the hero between the body
// paragraph and the pricing card. They take the place of the data
// that used to be embedded in the body para (preview score sentence
// + "also, competitor X is winning Y%" footnote) and surface it as
// the visual centerpiece of the personalized cohort experience.

/** Map a band label to a fill/text accent. Mirrors the dashboard's
 *  band-color convention. Uses existing CSS-variable palette only
 *  — no new colors introduced. */
function bandAccent(band: string): { hex: string; fg: string } {
  // The codebase's getTurfScoreBand returns labels: Invisible /
  // Patchy / Solid / Dominant / Rare air. The Sprint-2 spec uses
  // "Saturated" for 80+; we honor the codebase label ("Rare air")
  // since that's what the data carries, but the color treatment
  // matches the spec's intent.
  switch (band) {
    case 'Invisible':
      return { hex: '#ff4d4d', fg: '#ffffff' };
    case 'Patchy':
      return { hex: '#ff9f3a', fg: '#000000' };
    case 'Solid':
      return { hex: '#e8e54a', fg: '#000000' };
    case 'Dominant':
      return { hex: '#c5ff3a', fg: '#000000' };
    case 'Rare air':
    case 'Saturated':
      return { hex: '#c5ff3a', fg: '#000000' };
    default:
      return { hex: '#a1a1aa', fg: '#000000' };
  }
}

/** Plain-English interpretation per band label. Lookup table; falls
 *  back to a neutral string when an unfamiliar label comes through
 *  so the card never renders empty. */
function bandInterpretation(band: string): string {
  switch (band) {
    case 'Invisible':
      return "You're missing from most of your service area. Customers searching nearby aren't seeing you in the Map Pack.";
    case 'Patchy':
      return 'You appear in some neighborhoods but not most. Customers in significant parts of your service area aren’t finding you.';
    case 'Solid':
      return 'You appear in about half your service area. Above-average operators land here.';
    case 'Dominant':
      return 'You appear in most of your service area. Strong local visibility.';
    case 'Rare air':
    case 'Saturated':
      return 'You appear in nearly all your service area. Top-tier visibility.';
    default:
      return 'Your TurfScore measures how much of your service area you cover in Google’s local Map Pack.';
  }
}

/** Your Preview Score — primary visual anchor of the hero.
 *  Large score numeric + band label in band color + plain-English
 *  interpretation. Lime accent border so it visually anchors as the
 *  "your data" half of the score/competition pair. */
function YourPreviewScoreCard({
  score,
  band,
}: {
  score: number;
  band: string;
}) {
  const accent = bandAccent(band);
  return (
    <div
      className="rounded-lg p-5 md:p-6 border max-w-xl mb-5"
      style={{
        background: 'var(--color-card-glow)',
        borderColor: 'var(--color-border-bright)',
        boxShadow: '0 0 30px #c5ff3a10',
      }}
    >
      <div className="flex items-center gap-2 mb-3 text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
        <span style={{ color: 'var(--color-lime)' }}>●</span>
        <span style={{ color: 'var(--color-lime)' }}>Your preview score</span>
      </div>
      <div className="flex items-baseline gap-4 flex-wrap mb-3">
        <span
          className="font-display font-bold text-6xl md:text-7xl leading-none"
          style={{ color: 'var(--color-lime)' }}
        >
          {score}
        </span>
        <span
          className="font-display text-xl md:text-2xl font-semibold uppercase tracking-wider"
          style={{ color: accent.hex }}
        >
          {band}
        </span>
      </div>
      <p className="text-zinc-300 text-sm md:text-base leading-relaxed">
        {bandInterpretation(band)}
      </p>
    </div>
  );
}

/** The Competition — secondary card, warm-toned accent. Sits beneath
 *  Your Preview Score so the buyer's eye moves my-score → competitor-
 *  hold → CTA. Uses the existing --color-warn (orange) channel as a
 *  subtle border + tinted bg, not an alarm-style red. */
function TheCompetitionCard({
  competitorName,
  sharePct,
  city,
}: {
  competitorName: string;
  sharePct: number;
  city: string;
}) {
  return (
    <div
      className="rounded-lg p-5 md:p-6 border max-w-xl mb-5"
      style={{
        background: '#1f1308',
        borderColor: '#5a2f0a',
      }}
    >
      <div className="flex items-center gap-2 mb-3 text-[10px] uppercase tracking-[0.18em] font-mono font-semibold">
        <span style={{ color: 'var(--color-warn)' }}>●</span>
        <span style={{ color: 'var(--color-warn)' }}>The competition</span>
      </div>
      <h3 className="font-display text-xl md:text-2xl font-bold text-zinc-100 mb-2">
        {competitorName}
      </h3>
      <p className="text-zinc-200 text-sm md:text-base leading-relaxed mb-3">
        Currently winning{' '}
        <strong className="font-semibold" style={{ color: 'var(--color-warn)' }}>
          {sharePct}%
        </strong>{' '}
        of your service area.
      </p>
      <p className="text-zinc-400 text-sm leading-relaxed">
        Their cells are visible to customers across most of {city}. The full
        scan shows you exactly which cells they own — and where the gaps are.
      </p>
    </div>
  );
}
