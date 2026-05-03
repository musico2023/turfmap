import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Compass, Crown, Eye, FileText, Sparkles, Target } from 'lucide-react';
import { MarketingNav } from '@/components/marketing/MarketingNav';
import { MarketingHero } from '@/components/marketing/MarketingHero';
import { Section } from '@/components/marketing/Section';
import { PricingCards } from '@/components/marketing/PricingCards';
import { FAQAccordion } from '@/components/marketing/FAQAccordion';
import { MarketingFooter } from '@/components/marketing/MarketingFooter';
import { LinkButton } from '@/components/ui/Button';

export const metadata: Metadata = {
  title: 'TurfMap™ — See exactly where you rank across your territory',
  description:
    "TurfMap runs an 81-point geo-grid scan across your service area and shows you, cell by cell, where you appear in Google's local 3-pack. Local SEO diagnostic for service businesses. Delivered in minutes. From $99.",
  openGraph: {
    title: 'TurfMap™ — See exactly where you rank across your territory',
    description:
      "An 81-point geo-grid SEO diagnostic for home-services businesses. Find out where you're invisible in your own service area, and what to fix first. From $99.",
    url: 'https://turfmap.ai/',
    siteName: 'TurfMap.ai',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'TurfMap™ — See exactly where you rank',
    description:
      'An 81-point geo-grid SEO diagnostic. From $99, delivered in minutes.',
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
 * Section structure (matches the n=01..07 numbering used in the
 * eyebrow tags) maps to the prompt's required pattern:
 *   01 — Hero
 *   02 — Problem (why one rank check isn't enough)
 *   03 — Score anatomy (TurfReach / TurfRank / TurfScore explained)
 *   04 — What's in each tier
 *   05 — Pricing (Stripe Checkout)
 *   06 — FAQ
 *   07 — Closing CTA
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
            You checked your rank <em>once.</em> From your office. That&rsquo;s
            one search out of 81.
          </>
        }
        intro={
          <>
            Google personalizes local results by physical location. Someone
            searching from across town sees a completely different 3-pack than
            someone next door. A single rank check from your laptop tells you
            almost nothing about whether your service-area neighbors can find
            you.
          </>
        }
      >
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

      {/* 03 — Score anatomy */}
      <Section
        id="section-03"
        n={3}
        eyebrow="What you'll see"
        heading={
          <>
            Three numbers tell you everything you need to know — and{' '}
            <em>where to act first.</em>
          </>
        }
        intro="Every TurfMap returns the same three computed metrics. They're not vanity numbers — they map directly to specific fixes."
        tint
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-8">
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
              { range: '< 40%', label: 'Patchy', color: '#ff9f3a' },
              { range: '40–70%', label: 'Solid', color: '#e8e54a' },
              { range: '> 70%', label: 'Dominant', color: '#c5ff3a' },
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
                TurfRank <strong className="text-zinc-100">1.4</strong> means
                you&rsquo;re scraping the bottom of the pack — usually #3,
                often beneath competitors who optimized harder.
              </>
            }
            bands={[
              { range: '< 1.7', label: 'Bottom-of-pack', color: '#ff9f3a' },
              { range: '2.0–2.5', label: 'Solid', color: '#e8e54a' },
              { range: '> 2.6', label: 'Top-of-pack', color: '#c5ff3a' },
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
                Most home-services businesses we scan land between{' '}
                <strong className="text-zinc-100">30 and 55</strong> before
                optimization. Above 60 is uncommon — it usually means the
                Google Business Profile is well-tuned and the citations are
                clean.
              </>
            }
            bands={[
              { range: '0–20', label: 'Invisible', color: '#ff4d4d' },
              { range: '20–40', label: 'Patchy', color: '#ff9f3a' },
              { range: '40–60', label: 'Solid', color: '#e8e54a' },
              { range: '60–80', label: 'Dominant', color: '#c5ff3a' },
              { range: '80+', label: 'Rare air', color: '#c5ff3a' },
            ]}
            highlight
          />
        </div>

        {/* AI Coach preview */}
        <div className="mt-12">
          <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500 font-mono font-semibold mb-3 flex items-center gap-2">
            <Sparkles size={11} style={{ color: 'var(--color-lime)' }} />
            Plus: AI Coach
          </div>
          <div
            className="border rounded-lg p-5 md:p-6"
            style={{
              background: '#0a0f04',
              borderColor: 'var(--color-border-bright)',
            }}
          >
            <p className="text-zinc-300 leading-relaxed mb-4 max-w-3xl">
              Every scan is followed by a strategic readout: a one-paragraph
              diagnosis of what&rsquo;s actually causing the gap, plus three
              prioritized actions specific to your business and category. Not
              generic SEO advice — a read of your map.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {[
                {
                  priority: 'HIGH',
                  title: 'Add Midtown listing on Apple Maps via multi-location claim',
                  body: 'Apple Maps currently misattributes your Midtown location to a sibling address, suppressing proximity signals across the northern grid.',
                },
                {
                  priority: 'HIGH',
                  title: 'Claim 8 missing health-vertical directories',
                  body: 'Healthgrades, ZocDoc, Vitals, WebMD, and 4 others are entirely absent. Building citation authority here is the fastest TurfReach lever.',
                },
                {
                  priority: 'MEDIUM',
                  title: 'Normalize address format on Bing, RateMDs, MapQuest',
                  body: 'Three directories show abbreviated or malformed address strings. Fixing NAP consistency reduces noise that suppresses trust signals.',
                },
              ].map((a, i) => (
                <div
                  key={i}
                  className="border rounded-md p-4"
                  style={{
                    background: 'var(--color-bg)',
                    borderColor: 'var(--color-border)',
                  }}
                >
                  <div className="flex items-center justify-between mb-2">
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
                  <div className="font-display font-bold text-sm leading-snug mb-2 text-zinc-100">
                    {a.title}
                  </div>
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    {a.body}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-xs text-zinc-600 font-mono mt-3">
              Sample output. Your actions will be specific to your business,
              category, and what your map reveals.
            </p>
          </div>
        </div>
      </Section>

      {/* 04 — What's in each tier */}
      <Section
        id="section-04"
        n={4}
        eyebrow="Three tiers"
        heading={
          <>
            Buy the level of help that matches <em>how serious you are</em>{' '}
            about fixing this.
          </>
        }
        intro="$99 if you just want to see your map. $499 if you want a strategist's read on it. $1,497 if you want a 12-week plan and a 90-min call to walk through it."
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-8">
          <TierBrief
            label="$99 · TurfScan"
            who="For: business owners who want the data."
            description="The map, the three scores, and an AI Coach playbook of the top three things to fix. No human time, no consulting. Self-serve."
          />
          <TierBrief
            label="$499 · Visibility Audit"
            who="For: businesses that want to know what to fix first."
            description="Everything in the scan, plus a NAP audit, a category-specific GBP checklist, a citation-gap analysis vs your three nearest competitors, and a written diagnosis from a real strategist. Includes a 30-day re-scan."
            highlight
          />
          <TierBrief
            label="$1,497 · Strategy Session"
            who="For: businesses ready to act on it."
            description="The audit on three keywords, a 90-minute call with our SEO lead to walk the map, a 12-week priority-stacked action plan, and two re-scans (60 + 90 days) to verify the lift."
          />
        </div>
      </Section>

      {/* 05 — Pricing (Stripe checkout) */}
      <Section
        id="section-05"
        n={5}
        eyebrow="Pricing"
        heading={
          <>
            One purchase, no subscription. <em>Pick a tier and go.</em>
          </>
        }
        intro="Each tier is a single payment. After checkout you'll fill in your business details (name, address, keyword) and we'll fire the scan immediately."
        tint
      >
        <PricingCards />
        <p className="text-xs text-zinc-600 font-mono mt-8 text-center">
          All prices in USD. Refund policy: full refund within 24h if you
          haven&rsquo;t received your scan yet.
        </p>
      </Section>

      {/* 06 — FAQ */}
      <Section
        id="section-06"
        n={6}
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
                    AI Coach playbook. The Visibility Audit and Strategy
                    Session add the strategist&rsquo;s written diagnosis,
                    which lands within 2 business days.
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
                    in a city you don&rsquo;t live in. The $1,497 tier scans
                    three keywords so you can compare.
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
                    Yes. The Visibility Audit includes a 30-day re-scan, the
                    Strategy Session includes two (60 + 90 days). For ongoing
                    monthly tracking, ask us about{' '}
                    <a
                      href="https://localleadmachine.io"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-200 underline-offset-2 underline hover:text-white"
                    >
                      Local Lead Machine
                    </a>{' '}
                    — our managed monthly service that monitors and acts on
                    the map every month.
                  </>
                ),
              },
              {
                q: 'What does NAP mean?',
                a: (
                  <>
                    NAP is short for Name, Address, Phone — the three pieces
                    of business contact data that Google cross-references
                    across hundreds of directories (Apple Maps, Yelp, Bing,
                    Yellow Pages, vertical-specific ones like Healthgrades or
                    Angi, etc.). When NAP isn&rsquo;t consistent across those
                    directories, Google trusts your listing less, which
                    suppresses your appearance in the local 3-pack. Every
                    Visibility Audit includes a full NAP scan.
                  </>
                ),
              },
              {
                q: 'What is the local 3-pack?',
                a: (
                  <>
                    The three Google Maps results that appear at the top of
                    the page when you search for a local service (e.g.{' '}
                    <code>plumber toronto</code>). It&rsquo;s the most
                    valuable real estate in local search — the businesses
                    that land in the 3-pack capture the majority of clicks
                    and calls. TurfMap measures, cell by cell, whether you
                    appear there.
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
                    for home-services businesses since 2018. We built TurfMap
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

      {/* 07 — Closing CTA */}
      <Section
        id="section-07"
        n={7}
        eyebrow="Last call"
        heading={
          <>
            See your map. Then decide <em>what to do about it.</em>
          </>
        }
        intro="If you make it to the end of this page, you already suspect you've got a visibility problem. Worst case: $99 confirms it. Best case: you find a quick fix that pays for itself in one new customer."
      >
        <div className="flex flex-wrap items-center gap-3 mt-8">
          <LinkButton
            variant="primary"
            size="lg"
            href="#section-05"
            rightIcon={<ArrowRight size={16} strokeWidth={2.5} />}
          >
            Order your TurfMap audit
          </LinkButton>
          <LinkButton variant="ghost" size="lg" href="/login">
            I&rsquo;m an existing customer
          </LinkButton>
        </div>
        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <Trust icon={Eye} label="Real searches">
            81 actual Google queries per scan, not estimates.
          </Trust>
          <Trust icon={FileText} label="Real deliverable">
            PDF report you can keep, share, or hand to a freelancer.
          </Trust>
          <Trust icon={Sparkles} label="Built by operators">
            By the agency that uses it on its own clients every day.
          </Trust>
        </div>
      </Section>

      <MarketingFooter />
    </div>
  );
}

// ─── Sub-components used inline above ─────────────────────────────────────

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
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
          {title}
        </div>
        <span
          className="text-[9px] font-mono uppercase font-bold tracking-widest px-1.5 py-0.5 rounded"
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

function TierBrief({
  label,
  who,
  description,
  highlight = false,
}: {
  label: string;
  who: string;
  description: string;
  highlight?: boolean;
}) {
  return (
    <div
      className="border rounded-lg p-6"
      style={{
        background: highlight ? 'var(--color-card-glow)' : 'var(--color-card)',
        borderColor: highlight
          ? 'var(--color-border-bright)'
          : 'var(--color-border)',
      }}
    >
      <div
        className="font-display text-lg font-bold mb-2"
        style={{ color: highlight ? 'var(--color-lime)' : 'white' }}
      >
        {label}
      </div>
      <div className="text-xs text-zinc-500 font-mono uppercase tracking-wider mb-3">
        {who}
      </div>
      <p className="text-sm text-zinc-300 leading-relaxed">{description}</p>
    </div>
  );
}

function Trust({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Eye;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="border rounded-lg p-4"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
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
