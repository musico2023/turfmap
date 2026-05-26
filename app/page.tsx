import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight,
  Compass,
  Crown,
  Eye,
  FileText,
  MapPin,
  ShieldCheck,
  Sparkles,
  Target,
  Zap,
} from 'lucide-react';
import { MarketingNav } from '@/components/marketing/MarketingNav';
import { MarketingHero } from '@/components/marketing/MarketingHero';
import { Section } from '@/components/marketing/Section';
import { PricingCards } from '@/components/marketing/PricingCards';
import { MonitoringCards } from '@/components/marketing/MonitoringCards';
import { FAQAccordion } from '@/components/marketing/FAQAccordion';
import { MarketingFooter } from '@/components/marketing/MarketingFooter';
import { LinkButton } from '@/components/ui/Button';

export const metadata: Metadata = {
  title: 'TurfMap™ — See exactly where you rank across your territory',
  description:
    "TurfMap runs an 81-point geo-grid scan across your service area and shows you, cell by cell, where you appear in Google's local 3-pack. Local SEO diagnostic for service businesses. Delivered in under a minute. From $99.",
  // Canonical self-reference — tells Google the www homepage is the
  // one true URL, consolidating any apex / utm-tagged variants.
  alternates: { canonical: '/' },
  openGraph: {
    title: 'TurfMap™ — See exactly where you rank across your territory',
    description:
      "An 81-point geo-grid SEO diagnostic for local businesses — clinics, plumbers, dentists, restaurants, retail, anything that depends on Google's local 3-pack. Find out where you're invisible in your own service area, and what to fix first. From $99.",
    url: 'https://www.turfmap.ai/',
    siteName: 'TurfMap.ai',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'TurfMap™ — See exactly where you rank',
    description:
      'An 81-point geo-grid SEO diagnostic. From $99, delivered in seconds.',
  },
};

/**
 * Public marketing landing page. Replaces the previous root which was
 * the agency client-list (now at /clients).
 *
 * No auth check here on purpose — this is the conversion surface for
 * cold prospects. Authed agency users hitting / will see the marketing
 * page too; the top nav surfaces a "Sign in" link and the Header in
 * /clients lets them get back to the console.
 *
 * Section structure (matches the n=01..06 numbering used in the
 * eyebrow tags):
 *   01 — Hero
 *   02 — Problem (why one rank check isn't enough)
 *   03 — Score anatomy (TurfReach / TurfRank / TurfScore explained)
 *   04 — Pricing (Stripe Checkout — two-paths layout)
 *   05 — FAQ
 *   06 — Closing CTA
 *
 * The old section-04 ("Three tiers" — three audit-tier briefs)
 * was removed: it overlapped with section-04's Path A (one-time
 * audits) which already covers the same three SKUs in more depth.
 */
export default function MarketingLanding() {
  return (
    <div className="min-h-screen w-full text-white">
      <MarketingNav />

      {/* 01 — Hero (custom layout, doesn't use Section wrapper) */}
      <MarketingHero />

      {/* 02 — Problem */}
      <Section
        id="section-02"
        n={2}
        eyebrow="The problem"
        heading={
          <>
            You checked your rank <em>once.</em>{' '}From your office.
            That&rsquo;s one search out of 81.
          </>
        }
        subHeading={
          <>
            See exactly where in your service area customers can find
            you — and where they can&rsquo;t.
          </>
        }
        intro={
          <>
            Google personalizes local results by physical location. Someone
            searching from across town sees a completely different 3-pack than
            someone next door. A single rank check from your laptop tells you{' '}
            <strong className="font-semibold text-zinc-200">
              almost nothing
            </strong>{' '}
            about whether your service-area neighbors can find you.
          </>
        }
      >
        {/* Mechanism callout — spells out the 81-cell scan in plain
         *  terms before the compare cards. Bordered + tinted so it
         *  carries more weight than the intro paragraph above it
         *  without competing with the H2. Lime label echoes the
         *  section eyebrows used elsewhere on the page. */}
        <div
          className="border rounded-lg p-6 md:p-8 mt-2 mb-8 max-w-3xl"
          style={{
            background: 'var(--color-card)',
            borderColor: 'var(--color-border-bright)',
            boxShadow: '0 0 40px #c5ff3a0a',
          }}
        >
          <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3 flex items-center gap-2">
            <span style={{ color: 'var(--color-lime)' }}>·</span>
            <span style={{ color: 'var(--color-lime)' }}>How TurfMap works</span>{' '}
            · the 81-cell scan
          </div>
          <p className="font-display text-lg md:text-xl text-zinc-200 leading-snug">
            We lay a{' '}
            <strong className="font-semibold text-zinc-50">9×9 grid</strong>{' '}
            across your service area — <strong className="font-semibold text-zinc-50">
            81 points</strong> in total — and run a{' '}
            <strong className="font-semibold text-zinc-50">real Google search</strong>{' '}
            from each one. Every cell returns the local 3-pack as it
            appears to a searcher standing on that spot. You see, cell
            by cell, where you rank #1, where you slip, and where you
            don&rsquo;t appear at all.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-8">
          <CompareCard
            title="What most rank trackers tell you"
            tone="muted"
            badge="One number"
            body={
              <>
                <span className="font-mono text-zinc-300">
                  &ldquo;You rank #2 for plumber toronto.&rdquo;
                </span>{' '}
                Useful only if your business operates from a single point and
                every customer searches from that same point. Neither is true.
              </>
            }
          />
          <CompareCard
            title="What TurfMap tells you"
            tone="bright"
            badge="81 cell-level results"
            body={
              <>
                <span className="font-mono text-zinc-100">
                  &ldquo;You rank #1 in 12 cells, #2 in 14, #3 in 11, and don&rsquo;t
                  appear at all in 44.&rdquo;
                </span>{' '}
                Now you know the shape of your territory: where you dominate,
                where you fade, and where your competitors own the conversation.
              </>
            }
          />
        </div>
      </Section>

      {/* 03 — What you'll get
       *
       * Phase 2 restructure: Fix List leads, score cards demoted to
       * supporting evidence beneath. Operator-buyers buy fixes, not
       * metrics — the section now reads "here's what you'll do
       * (Fix List), and here's the math behind it (score cards)."
       *
       * Sub-section break: a thin lime accent line + extra vertical
       * spacing between the Fix List and the score cards signals the
       * shift from "what you'll get" to "how we know" without a heavy
       * heading change.
       */}
      <Section
        id="section-03"
        n={3}
        eyebrow="What you'll get"
        heading={
          <>
            A prioritized fix list. <em>In plain English.</em>
          </>
        }
        intro={
          <>
            Every TurfScan ends with a fix list. Three prioritized actions
            specific to your business and category, written by our AI Coach
            from your real audit data — not generic SEO advice.{' '}
            <strong className="font-semibold text-zinc-200">
              You walk away knowing what to fix, in what order.
            </strong>
          </>
        }
        headerAside={<CoachSignature />}
        tint
      >
        {/* PRIMARY — the Fix List (AI Coach output). Visual centerpiece
         *  of the section. Brighter card surface + lime border so the
         *  eye lands here first when scrolling into the section. */}
        <div className="mt-8">
          <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3 flex items-center gap-2">
            <Sparkles size={11} style={{ color: 'var(--color-lime)' }} />
            <span style={{ color: 'var(--color-lime)' }}>The fix list</span> ·
            what you&rsquo;ll actually do
          </div>
          <div
            className="border rounded-lg p-5 md:p-7"
            style={{
              background: '#0a0f04',
              borderColor: 'var(--color-border-bright)',
            }}
          >
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
              {[
                {
                  priority: 'HIGH',
                  title: 'Verify your Apple Maps listing — currently unverified',
                  body: 'iPhone users searching from the northern half of your service area get directed to a verified competitor. Verifying the listing is a 5-minute fix that immediately reclaims those cells.',
                },
                {
                  priority: 'HIGH',
                  title: 'Claim 8 missing industry directories',
                  body: 'For this plumber: Angi, HomeAdvisor, Thumbtack, BBB, and 4 others — all absent. The exact list is industry-specific. Citation authority on the directories Google cross-references is the fastest TurfReach lever.',
                },
                {
                  priority: 'MEDIUM',
                  title: 'Normalize address format on Bing, Yelp, MapQuest',
                  body: 'Three directories show abbreviated or malformed address strings. Fixing NAP consistency reduces noise that suppresses trust signals.',
                },
              ].map((a, i) => (
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
                        border: `1px solid ${a.priority === 'HIGH' ? 'var(--color-border-bright)' : '#3a2a0a'}`,
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
            {/* Grounding callout — articulates what makes this AI Coach
             *  different from generic SEO chatbots. Inline within the
             *  same panel (not a separate card) so it reads as a
             *  closing note on the sample output. */}
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
                Every recommendation cites the specific directories you&rsquo;re
                missing from, the inconsistencies in your business listing,
                and the moves that map to your industry. No generic SEO advice
                — real audit findings, prioritized.
              </div>
            </div>

            <p className="text-xs text-zinc-600 font-mono mt-3">
              Sample output. Your actions will be specific to your business,
              category, and what your map reveals.
            </p>
          </div>
        </div>

        {/* SECONDARY — the three score cards demoted as supporting
         *  evidence ("how we know"). The thin lime accent line + extra
         *  top margin signals the sub-section break: we're moving
         *  from "what you'll get" to "the math behind it." Mirrors
         *  the Path A/B divider treatment in Section 04 so the page's
         *  visual vocabulary stays consistent. */}
        <div className="mt-16 md:mt-20 max-w-4xl">
          <div
            aria-hidden
            className="h-[1px] w-16 mb-6"
            style={{
              background: 'var(--color-lime)',
              boxShadow: '0 0 10px #c5ff3a44',
            }}
          />
          <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3 flex items-center gap-2">
            <span style={{ color: 'var(--color-lime)' }}>·</span>
            <span style={{ color: 'var(--color-lime)' }}>How we know</span> ·
            three numbers we compute from your scan
          </div>
          <p className="text-sm text-zinc-400 leading-relaxed max-w-3xl">
            Every fix list is anchored in three computed metrics. They map
            directly to specific actions — that&rsquo;s why the recommendations
            above are prioritized the way they are.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-6">
          <ScoreCard
            icon={Compass}
            name="TurfReach"
            tagline="How much of your area you cover"
            range="0 – 100%"
            description="The percentage of your 81 grid cells where you appear in the local 3-pack at all."
            example={
              <>
                A TurfReach of <strong className="text-zinc-100">35%</strong>{' '}
                means two-thirds of nearby searchers don&rsquo;t see you when
                they search for your service.
              </>
            }
            bands={[
              { range: '< 20%', label: 'Invisible', color: '#ff4d4d' },
              { range: '20–40%', label: 'Patchy', color: '#ff9f3a' },
              { range: '40–60%', label: 'Solid', color: '#e8e54a' },
              { range: '60–80%', label: 'Dominant', color: '#c5ff3a' },
              { range: '80+%', label: 'Saturated', color: '#f5c842' },
            ]}
          />
          <ScoreCard
            icon={Crown}
            name="TurfRank"
            tagline="Where you sit when you do appear"
            range="1.0 – 3.0"
            description="The 3-pack has three slots. TurfRank is your average position across the cells where you actually appear. 3.0 = always #1, 1.0 = always #3."
            example={
              <>
                TurfRank <strong className="text-zinc-100">1.4</strong>{' '}
                means you&rsquo;re scraping the bottom of the pack —
                usually #3, often beneath competitors who optimized
                harder.
              </>
            }
            bands={[
              { range: '< 1.0', label: 'Edge of pack', color: '#ff4d4d' },
              { range: '1.0–1.5', label: 'Bottom-pack', color: '#ff9f3a' },
              { range: '1.5–2.0', label: 'Mid-pack', color: '#e8e54a' },
              { range: '2.0–2.5', label: 'Top-pack', color: '#c5ff3a' },
              { range: '2.5+', label: 'Position #1', color: '#f5c842' },
            ]}
          />
          <ScoreCard
            icon={Target}
            name="TurfScore"
            tagline="Composite visibility"
            range="0 – 100"
            description="Combines TurfReach and TurfRank into one number. The headline metric you can quote, track, and improve."
            example={
              <>
                Most local businesses we scan land between{' '}
                <strong className="text-zinc-100">30 and 55</strong>{' '}
                before optimization. Above 60 is uncommon — it usually
                means the Google Business Profile is well-tuned and the
                citations are clean.
              </>
            }
            bands={[
              { range: '0–20', label: 'Invisible', color: '#ff4d4d' },
              { range: '20–40', label: 'Patchy', color: '#ff9f3a' },
              { range: '40–60', label: 'Solid', color: '#e8e54a' },
              { range: '60–80', label: 'Dominant', color: '#c5ff3a' },
              { range: '80+', label: 'Rare air', color: '#f5c842' },
            ]}
            highlight
          />
        </div>
      </Section>

      {/* 04 — Pricing (Stripe checkout)
       *
       * Two-paths layout. Buyers self-sort by buying mode (one-time
       * vs. recurring) BEFORE comparing within a path. Previously the
       * five tiers stacked in a single sequence under one H2 ("Pick
       * your audit. Then keep watching."), which produced choice
       * paralysis between fundamentally different products.
       *
       *   PATH A — One-time audits (3 cards: $99 / $499 / $1,497).
       *            For buyers who want a diagnosis to take to a team
       *            or vendor.
       *   PATH B — Continuous monitoring (2 cards: Pulse $39, Pulse+
       *            $99 with 3-month minimum / $79 annual). For buyers
       *            who want continuous improvement, not a one-shot.
       *
       * Each path has its own header block (eyebrow + H3 + body),
       * its own card grid, and a small contextual footer note
       * pointing at Fourdots Digital's Local Lead Machine for
       * full-service implementation. A subtle horizontal divider
       * + extra vertical margin between the paths anchors the
       * separation visually.
       *
       * The agency-comparison anchor ("most agencies charge
       * $1,500-$2,500+") is repositioned from a top-level intro
       * into Path A's header block — it's specifically a comparison
       * for the audit buyer, not the subscription buyer.
       */}
      <Section
        id="section-04"
        n={4}
        eyebrow="Pricing"
        heading={
          <>
            Two paths. Pick the one that fits <em>how you work.</em>
          </>
        }
        tint
      >
        {/* PATH A — one-time audits */}
        <PathHeader
          category="One-time audits"
          body={
            <>
              Get an audit. We scan your territory, diagnose what&rsquo;s
              breaking your visibility, and walk you through what to fix
              —{' '}
              <strong className="font-semibold text-zinc-100">once</strong>
              . Hand the report to your team, share it with a freelancer,
              or use it to evaluate vendors.
            </>
          }
          comparison={
            <>
              Compare: most agencies charge{' '}
              <span className="text-zinc-300 font-semibold">$1,500–$2,500+</span>{' '}
              before they&rsquo;ll even look at your map pack. TurfMap audits
              start at <span style={{ color: 'var(--color-lime)' }}>$99</span>.
            </>
          }
        />
        <PricingCards />

        {/* Lift Promise callout — surfaces the audit guarantee
         *  outside the pricing-card bullet list so it doesn't get
         *  buried as bullet #8. Visible just below the Path A
         *  cards so any operator who scrolls past the audit price
         *  sees the risk reversal before they bounce. Lime accent
         *  border, ShieldCheck icon, terse + promise-shaped copy
         *  matching the homepage's other small-card vocabulary
         *  (the "Multiple locations? Add them linearly" affordance
         *  on Path B). Audit + Strategy share the guarantee — both
         *  tiers' purchases trigger the 30-day re-scan + 60-day
         *  check-in flow that the promise is grounded in. */}
        <div
          className="mt-10 mx-auto max-w-3xl rounded-lg border p-5 flex items-start gap-3"
          style={{
            background: 'var(--color-card-glow)',
            borderColor: 'var(--color-border-bright)',
            boxShadow: '0 0 24px #c5ff3a14',
          }}
        >
          <ShieldCheck
            size={18}
            className="flex-shrink-0 mt-0.5"
            style={{ color: 'var(--color-lime)' }}
          />
          <div className="text-sm text-zinc-300 leading-relaxed">
            <span className="font-semibold text-zinc-100">
              Backed by the TurfScore Lift Promise.
            </span>{' '}
            <span className="text-zinc-400">
              Every Visibility Audit and Strategy Session ships with a{' '}
              <strong className="font-semibold text-zinc-200">
                minimum 10-point TurfScore lift in 30 days
              </strong>{' '}
              — measured by the automated re-scan that&rsquo;s built
              into your audit. If your map doesn&rsquo;t move 10 points
              after you&rsquo;ve executed the 90-Day Roadmap,{' '}
              <strong className="font-semibold text-zinc-200">
                we redo the analysis at no charge.
              </strong>
            </span>
          </div>
        </div>

        <PathFooterNote>
          Audit buyers who decide they want full implementation typically
          engage{' '}
          <PathFooterLink href="https://fourdots.io/home-services">
            Fourdots Digital&rsquo;s Local Lead Machine
          </PathFooterLink>{' '}
          for done-for-you local SEO and ad management. We&rsquo;ll discuss
          options on the strategist call.
        </PathFooterNote>

        {/* PATH B — continuous monitoring.
         *  No standalone <hr> divider — the accent line above the
         *  Path B label (rendered inside PathHeader) now carries the
         *  inter-path break visually. */}
        <PathHeader
          category="Continuous monitoring"
          body={
            <>
              Get a subscription. We track your visibility weekly, alert
              you when it shifts, and (on Pulse+){' '}
              <strong className="font-semibold text-zinc-100">
                build and maintain citations
              </strong>{' '}
              across ~25 industry directories on your behalf.
            </>
          }
        />
        <MonitoringCards />

        {/* Per-location add-on. Linear pricing — no tier-jump tax for
         *  multi-location operators. The whole reason the schema is
         *  multi-location-native is so franchise / multi-clinic /
         *  multi-storefront operators can layer locations as needed.
         *  Lives inside Path B since it only applies to subscription
         *  tiers. */}
        <div
          className="mt-10 mx-auto max-w-3xl rounded-lg border p-5 flex items-start gap-3"
          style={{
            background: 'var(--color-bg)',
            borderColor: 'var(--color-border)',
          }}
        >
          <MapPin
            size={18}
            className="flex-shrink-0 mt-0.5"
            style={{ color: 'var(--color-lime)' }}
          />
          <div className="text-sm text-zinc-300 leading-relaxed">
            <span className="font-semibold text-zinc-100">
              Multiple locations? Add them linearly.
            </span>{' '}
            <span className="text-zinc-400">
              <span className="font-mono">+$25/mo</span> per additional
              location on Pulse,{' '}
              <span className="font-mono">+$35/mo</span> on Pulse+.
              <br />
              No tier ladders, no per-location penalties.
            </span>
          </div>
        </div>

        <PathFooterNote>
          Looking for full-service local SEO instead of self-serve
          monitoring?{' '}
          <PathFooterLink href="https://fourdots.io/home-services">
            See Fourdots Digital&rsquo;s Local Lead Machine →
          </PathFooterLink>
        </PathFooterNote>

        <p className="text-xs text-zinc-600 font-mono mt-10 text-center">
          All prices in USD. Refund policy: full refund within 24h if you
          haven&rsquo;t received your scan yet.
        </p>
      </Section>

      {/* 05 — FAQ */}
      <Section
        id="section-05"
        n={5}
        eyebrow="Common questions"
        heading={
          <>
            Things people ask before <em>they buy.</em>
          </>
        }
      >
        <div className="mt-6">
          <FAQAccordion
            items={[
              {
                q: 'How long does it take to receive my TurfMap?',
                a: (
                  <>
                    The scan itself finishes in under a minute — we run all 81
                    queries in parallel against Google&rsquo;s local-pack feed.
                    After you fill in your business details on the order form,
                    you&rsquo;ll get an email with a link to your map and your
                    AI Coach Fix List. The Visibility Audit adds a 30-min
                    strategist call (you pick the slot), and the 90-Day
                    Roadmap PDF lands within 24 hours of that call. Strategy
                    Session adds a 90-min strategist deep-dive scheduled
                    within 2 business days.
                  </>
                ),
              },
              {
                q: 'What keyword should I pick?',
                a: (
                  <>
                    Pick the most-searched term someone in your service area
                    would type to find a business like yours. For a plumber,
                    that&rsquo;s usually <code>plumber [city]</code> — not your
                    business name, not a niche service. If you&rsquo;re unsure,
                    pick what you&rsquo;d type if you needed your own service
                    in a city you don&rsquo;t live in. The Strategy Session
                    scans three keywords so you can compare.
                  </>
                ),
              },
              {
                q: 'Is this US-only?',
                a: (
                  <>
                    No. TurfMap works anywhere Google&rsquo;s local 3-pack
                    works — US, Canada, UK, Australia, EU, and most of the
                    rest of the world. The grid is centered on your business
                    address regardless of country.
                  </>
                ),
              },
              {
                q: "What if I'm not in any of the cells?",
                a: (
                  <>
                    Your map will show 81 red cells and a TurfScore of 0. That
                    is genuinely useful information — it tells you the
                    optimization gap is total, not partial, and the AI Coach
                    will give you a foundational checklist (verify GBP, fix
                    NAP, file primary citations) instead of the
                    fine-tuning advice it would otherwise produce. No tier is
                    refunded on the basis of a low score; the diagnostic is
                    the product.
                  </>
                ),
              },
              {
                q: 'Can I rerun the scan later?',
                a: (
                  <>
                    Your TurfScan ($99) gives you one scan — the
                    diagnosis. To track your map over time and catch
                    changes as they happen, that&rsquo;s what{' '}
                    <strong className="font-semibold text-zinc-200">
                      TurfMap Pulse
                    </strong>{' '}
                    is for ($39/mo) — same dashboard, automatic weekly
                    re-scans, alerts when your visibility shifts.{' '}
                    <strong className="font-semibold text-zinc-200">
                      Pulse+
                    </strong>{' '}
                    ($99/mo, 3-month minimum) adds citation-building on
                    top. We also offer fully managed monthly services
                    where we don&rsquo;t just measure the map, we act on
                    it; the right fit depends on your category and how
                    much of this you want to handle yourself.
                  </>
                ),
              },
              {
                q: 'How is this different from just Googling myself?',
                a: (
                  <>
                    Google personalizes local results by your physical
                    location. From your office, you&rsquo;ll always see
                    yourself near the top — that&rsquo;s not proof you rank
                    well, it&rsquo;s proof Google knows where you are.
                    Customers searching from across town see completely
                    different results. TurfMap scans 81 different physical
                    points across your service area to show you what those
                    customers actually see, not what you see from your desk.
                  </>
                ),
              },
              {
                q: 'What are citations, and why does my business need them?',
                a: (
                  <>
                    Citations are listings of your business name, address,
                    and phone number across directories like Yelp, BBB,
                    Angi, and trade-specific sites. When these are
                    consistent and complete across the directories Google
                    trusts, your Map Pack visibility goes up. When
                    they&rsquo;re inconsistent or missing, Google penalizes
                    you. Most local businesses have citation issues without
                    knowing it — TurfScan finds them.
                  </>
                ),
              },
              {
                q: "What's the Map Pack, and why does it matter for my business?",
                a: (
                  <>
                    The Map Pack is the box of three local businesses
                    Google shows on Maps results when someone searches for
                    a service near them. For most local businesses, ranking
                    in the Map Pack drives more calls than any other Google
                    placement. If you&rsquo;re not in the Map Pack across
                    your service area, customers searching nearby are
                    calling someone else.
                  </>
                ),
              },
              {
                q: 'How is this different from other rank-tracking tools?',
                a: (
                  <>
                    Most tools give you a single rank number — like
                    &ldquo;you&rsquo;re #2 for plumber Toronto.&rdquo;
                    That&rsquo;s almost useless because it ignores that
                    your visibility changes neighborhood by neighborhood.
                    TurfMap scans 81 points across your actual service
                    area to show you where you&rsquo;re visible, where
                    you&rsquo;re not, and what to fix. You&rsquo;re paying
                    for the diagnosis and the fix list, not just the data.
                  </>
                ),
              },
              {
                q: "What if my TurfScore doesn't go up after the Visibility Audit?",
                a: (
                  <>
                    Every Visibility Audit ships with a{' '}
                    <strong className="font-semibold text-zinc-200">
                      10-point TurfScore Lift Promise
                    </strong>
                    : if your 30-day automated re-scan doesn&rsquo;t
                    show at least a 10-point lift after you&rsquo;ve
                    executed the 90-Day Roadmap, we redo the analysis
                    at no charge. The 60-day strategist check-in
                    catches anything the first roadmap missed and
                    adjusts the plan. The promise is the contract —
                    we wouldn&rsquo;t put it in writing if it
                    didn&rsquo;t hold up across the categories we
                    work in.
                  </>
                ),
              },
              {
                q: 'Will I need to fix this stuff myself, or do you do it?',
                a: (
                  <>
                    TurfScan ($99) gives you the diagnosis and the fix
                    list — you, your team, or your existing freelancer can
                    act on it. TurfMap Pulse+ ($99/mo) builds and maintains
                    your citations automatically — we do that part for you.
                    If you want full done-for-you local SEO and ad
                    management, our parent company Fourdots Digital offers
                    that under{' '}
                    <a
                      href="https://fourdots.io/home-services"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2 hover:text-zinc-100 transition-colors"
                    >
                      Local Lead Machine
                    </a>
                    . We&rsquo;ll discuss your options on the strategist
                    call if you book one of the audit tiers.
                  </>
                ),
              },
              {
                q: "Who's behind TurfMap?",
                a: (
                  <>
                    TurfMap is built and operated by{' '}
                    <a
                      href="https://fourdots.io"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-200 underline-offset-2 underline hover:text-white"
                    >
                      Fourdots Digital
                    </a>{' '}
                    — a Toronto-based agency that&rsquo;s been doing local SEO
                    for service businesses since 2018. We built TurfMap
                    because the off-the-shelf rank trackers our clients were
                    using told them they ranked #1 from their office and
                    didn&rsquo;t mention they were invisible 3km down the
                    road. So we built one that does.
                  </>
                ),
              },
            ]}
          />
        </div>
      </Section>

      {/* 06 — Closing CTA */}
      <Section
        id="section-06"
        n={6}
        eyebrow="Last call"
        heading={
          <>
            See your map. Then decide <em>what to do about it.</em>
          </>
        }
        intro={
          <>
            If you make it to the end of this page, you already suspect
            you&rsquo;ve got a visibility problem.
            <br />
            Worst case:{' '}
            <strong className="font-semibold text-zinc-200">
              $99 confirms it
            </strong>
            .
            <br />
            Best case: you find a quick fix that{' '}
            <strong className="font-semibold text-zinc-200">
              pays for itself in one new customer
            </strong>
            .
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-3 mt-8">
          <LinkButton
            variant="primary"
            size="lg"
            href="#section-04"
            rightIcon={<ArrowRight size={16} strokeWidth={2.5} />}
          >
            Order your TurfMap audit
          </LinkButton>
          <LinkButton variant="ghost" size="lg" href="/login">
            I&rsquo;m an existing customer
          </LinkButton>
        </div>
        {/* Trust strip — three short reassurances anchoring the closing
         *  CTA. Pre-fix these sat as three independent cards on the
         *  section's transparent surface and visually orphaned from
         *  the heading/CTA above. Now wrapped in a single tinted
         *  container with a small eyebrow so they read as the closing
         *  beat of the section, not a separate row of widgets. The
         *  inner cards lose their individual borders/backgrounds and
         *  become flush items inside the unifying container. */}
        <div
          className="mt-10 rounded-lg p-6 md:p-8"
          style={{
            background: 'var(--color-card)',
            border: '1px solid var(--color-border)',
          }}
        >
          <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-5 flex items-center gap-1.5">
            <span style={{ color: 'var(--color-lime)' }}>·</span>
            Why this is real software, not a PDF mill
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8 text-sm">
            <TrustInline icon={Eye} label="Real searches">
              81 actual Google queries per scan, not estimates.
            </TrustInline>
            <TrustInline icon={FileText} label="Real deliverable">
              Branded PDF report you can keep, share, or hand to a freelancer.
            </TrustInline>
            <TrustInline icon={Sparkles} label="Built by operators">
              By the agency that uses it on its own clients every day.
            </TrustInline>
          </div>
        </div>
      </Section>

      <MarketingFooter />
    </div>
  );
}

// ─── Sub-components used inline above ─────────────────────────────────────

/**
 * Subsection header used inside Section 05 to split "One-time audits"
 * from "Continuous monitoring." Smaller than the section H2 — uses the
 * same eyebrow + heading pattern as Section but at a level down so the
 * eye reads "this is one section split into two product groupings,"
 * not "two top-level sections jammed together."
 */
/**
 * Section 05 path header. Used twice per page (audits, subscriptions)
 * to anchor each buying mode as its own visual block.
 *
 * Treatment iteration history:
 *   - v1: subsection title + sub-head (`SubsectionHeader`).
 *   - v2: lime "Path A · One-time audits" eyebrow + H3 question +
 *         body. The H3 overstacked vs. the section H2.
 *   - v3 (current): lime accent line + larger lime mono label
 *         ("· ONE-TIME AUDITS") + body. The "Path A/B" dev-spec
 *         prefix was buyer-noise and dropped. The accent line +
 *         larger label combination produces a real visual block
 *         break, not just a typographic flourish — buyers
 *         scrolling the section now perceive two clearly
 *         separated paths instead of one continuous list of
 *         products.
 *
 * The accent line is full-width-of-content (max-w-3xl), 2px tall,
 * with a subtle lime glow. Top margin is generous (~80px above the
 * accent line) so the path break reads as a "new section" not "next
 * item." Doubles as the inter-path separator — the standalone <hr>
 * divider that used to sit between the two paths was removed since
 * the accent line above Path B's label now carries that work.
 */
function PathHeader({
  category,
  body,
  comparison,
}: {
  category: string;
  body: React.ReactNode;
  /** Optional small sub-line beneath the body. Used on Path A for
   *  the agency-cost comparison anchor. */
  comparison?: React.ReactNode;
}) {
  return (
    <div className="mt-20 mb-8 max-w-3xl">
      {/* Lime accent line — full width of content column. 2px with a
       *  subtle glow so it reads as a deliberate break, not a hairline. */}
      <div
        aria-hidden
        className="h-[2px] w-full mb-6"
        style={{
          background: 'var(--color-lime)',
          boxShadow: '0 0 14px #c5ff3a55',
        }}
      />
      {/* Path label — bumped from eyebrow size to H3-equivalent
       *  (~18-20px), lime, mono, uppercase tracking. The "·" prefix
       *  is kept as a soft visual anchor; the "Path A/B" dev-spec
       *  prefix is dropped. */}
      <div
        className="text-base md:text-lg uppercase tracking-[0.22em] font-mono font-semibold mb-4"
        style={{ color: 'var(--color-lime)' }}
      >
        · {category}
      </div>
      <p className="text-sm md:text-base text-zinc-300 leading-relaxed">
        {body}
      </p>
      {comparison && (
        <p className="text-xs text-zinc-500 leading-relaxed mt-3">
          {comparison}
        </p>
      )}
    </div>
  );
}

/**
 * Section 03 right-side visual — a "signature card" for the TurfMap
 * AI Coach. Visually balances the heading row (which used to feel
 * left-heavy at desktop widths now that the Fix List leads the
 * section) and reinforces the AI Coach as the system that produces
 * the Fix List below.
 *
 * Uses the same dark-green tint + lime border vocabulary as the Fix
 * List panel beneath it, so the card reads as a "stamp" or "name
 * plate" attributing the recommendations. The constellation of
 * lime sparkles at the top + the central icon picks up the user's
 * "stars" cue without leaning into a 5-star-rating motif (which
 * would imply customer reviews, not the AI agent).
 */
function CoachSignature() {
  return (
    <div
      className="rounded-lg border p-5 relative overflow-hidden"
      style={{
        background: '#0a0f04',
        borderColor: 'var(--color-border-bright)',
        boxShadow: '0 0 30px #c5ff3a18',
      }}
    >
      {/* Constellation — three small sparkles scattered above the
       *  central mark. Different sizes + opacities create depth so
       *  the row reads as a constellation, not a fixed pattern. */}
      <div className="flex items-center gap-3 mb-4 pl-1">
        <Sparkles
          size={9}
          style={{ color: 'var(--color-lime)', opacity: 0.7 }}
        />
        <Sparkles
          size={11}
          style={{ color: 'var(--color-lime)', opacity: 0.45 }}
        />
        <Sparkles
          size={8}
          style={{ color: 'var(--color-lime)', opacity: 0.85 }}
        />
      </div>

      {/* Central mark — a single big lime Sparkles icon in a tinted
       *  square, mirroring the header's TurfMap crosshair-on-lime
       *  brand mark but with the AI / sparkle motif instead. */}
      <div
        className="flex items-center justify-center w-12 h-12 rounded-md mb-4"
        style={{
          background: '#1a2010',
          border: '1px solid var(--color-border-bright)',
        }}
      >
        <Sparkles
          size={22}
          strokeWidth={2.25}
          style={{ color: 'var(--color-lime)' }}
        />
      </div>

      {/* Wordmark + ™ */}
      <div className="font-display text-xl md:text-2xl font-bold leading-tight text-zinc-100 mb-1">
        TurfMap AI Coach
        <span
          className="text-xs align-top ml-0.5"
          style={{ color: 'var(--color-lime)' }}
        >
          ™
        </span>
      </div>

      {/* One-line tagline — operator-language. Two short sentences
       *  with the line break preserved by leading-snug for rhythm. */}
      <p className="text-sm text-zinc-400 leading-snug mb-4">
        Reads your map.
        <br />
        Writes your fixes.
      </p>

      {/* Bottom strip — small attribution note, mono, dim, with a
       *  thin top border so it reads as a footer on the card. */}
      <div
        className="pt-3 border-t text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-600"
        style={{ borderColor: 'var(--color-border)' }}
      >
        Signs every scan.
      </div>
    </div>
  );
}

/**
 * Small contextual note beneath each path's card grid. Visually
 * subtle — same typographic weight as the bottom-of-section refund
 * line. Reads as a sidebar note, not a sales callout.
 */
function PathFooterNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs text-zinc-600 mt-8 text-center max-w-3xl mx-auto leading-relaxed">
      {children}
    </p>
  );
}

/**
 * Subtle link styling for the footer-note's "Local Lead Machine"
 * pointer. Default state is just-slightly-brighter zinc to keep it
 * understated; underline appears only on hover so the line reads
 * cleanly at rest.
 */
function PathFooterLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-zinc-400 hover:text-zinc-200 hover:underline transition-colors"
    >
      {children}
    </a>
  );
}

function CompareCard({
  title,
  tone,
  badge,
  body,
}: {
  title: string;
  tone: 'muted' | 'bright';
  badge: string;
  body: React.ReactNode;
}) {
  const bright = tone === 'bright';
  return (
    <div
      className="border rounded-lg p-6"
      style={{
        background: bright ? 'var(--color-card-glow)' : 'var(--color-card)',
        borderColor: bright
          ? 'var(--color-border-bright)'
          : 'var(--color-border)',
      }}
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
          {title}
        </div>
        <span
          className="text-[9px] font-mono uppercase font-bold tracking-widest px-1.5 py-0.5 rounded self-start sm:self-auto whitespace-nowrap"
          style={{
            background: bright ? '#1a2010' : 'var(--color-bg)',
            color: bright ? 'var(--color-lime)' : '#a1a1aa',
            border: `1px solid ${bright ? 'var(--color-border-bright)' : 'var(--color-border)'}`,
          }}
        >
          {badge}
        </span>
      </div>
      <p className="text-zinc-300 leading-relaxed">{body}</p>
    </div>
  );
}

function ScoreCard({
  icon: Icon,
  name,
  tagline,
  range,
  description,
  example,
  bands,
  highlight = false,
}: {
  icon: typeof Compass;
  name: string;
  tagline: string;
  range: string;
  description: string;
  example: React.ReactNode;
  bands: { range: string; label: string; color: string }[];
  highlight?: boolean;
}) {
  return (
    <div
      className="border rounded-lg p-6 flex flex-col"
      style={{
        background: highlight ? 'var(--color-card-glow)' : 'var(--color-bg)',
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
      <div className="font-display text-2xl font-bold mb-1">
        {name}
        <span
          className="text-xs align-top ml-0.5"
          style={{ color: 'var(--color-lime)' }}
        >
          ™
        </span>
      </div>
      <div className="text-xs text-zinc-400 mb-4">{tagline}</div>
      <p className="text-sm text-zinc-300 leading-relaxed mb-3">{description}</p>
      <p className="text-sm text-zinc-400 leading-relaxed mb-5">
        <span className="text-[9px] font-mono uppercase tracking-[0.18em] text-zinc-500 mr-2">
          E.g.
        </span>
        {/* Explicit space character — Tailwind's mr-2 provides the
         *  visual gap, but some clipboard / accessibility readers
         *  collapse pure-margin spacing into "E.g.TurfRank". This
         *  guarantees a real whitespace token between the eyebrow
         *  and the example body. */}
        {' '}
        {example}
      </p>
      <div className="mt-auto pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-2">
          Bands
        </div>
        <div className="space-y-1">
          {bands.map((b) => (
            <div key={b.label} className="flex items-center justify-between text-xs">
              <span className="font-mono text-zinc-600">{b.range}</span>
              <span className="font-mono font-semibold" style={{ color: b.color }}>
                {b.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Inline trust item — used inside the unifying Section 07 container.
 * Replaces the previous standalone-card Trust component which created
 * the visual orphaning issue. No individual border/background; the
 * item relies on the parent container for chrome.
 */
function TrustInline({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Eye;
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
      <p className="text-zinc-400 leading-relaxed">{children}</p>
    </div>
  );
}
