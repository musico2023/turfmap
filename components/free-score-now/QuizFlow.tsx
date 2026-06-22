'use client';

/**
 * QuizFlow — quizflow-format lead-capture funnel for /free-score-now.
 *
 * Ported structural pattern from the Logik Group Insulation Rebate
 * funnel (see /Users/anthonyalfonsi/Claude/quizflow/). Skinned in
 * TurfMap colors (lime / dark) and Bricolage Grotesque display type.
 *
 * Conversion principles preserved verbatim:
 *   - Mobile-first device-frame container (max-width 440px, full
 *     screen on mobile, phone-shaped card with shadow on desktop)
 *   - Persistent top progress bar + circular back button
 *   - One question per step (low cognitive load, momentum builds)
 *   - HARD-QUALIFY first (Q1 routes non-operators to a graceful
 *     dead-end before the user invests effort)
 *   - Single-select cards with icon + tick affordance
 *   - Contact step LAST — the conversion event
 *   - Slide animation between steps (slideIn / slideOut, ~420ms)
 *
 * Submit path:
 *   /api/score/preview-init  (lead_source='free_score' →
 *     unlock-init auto-applies MAPCHECK50 on /share, same as the
 *     existing long-scroll /free-score lander)
 *   → on success, fires trackMetaEvent('Lead', …) for the pixel
 *     and redirects the buyer to /share/<shareId> where the scan
 *     reveals plus the $49 unlock CTA live.
 *
 * Disqualify branch:
 *   Q1 "no, not me" routes to a soft dead-end card with a link
 *   back to the homepage. Mirrors the Logik renter dead-end.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Check,
  Compass,
  Crosshair,
  Crown,
  Flame,
  Hammer,
  Home,
  Layers,
  Mail,
  MapPin,
  Megaphone,
  PaintBucket,
  Phone,
  Search,
  Sparkles,
  Star,
  Trees,
  Users,
  Wrench,
} from 'lucide-react';
import { TurnstileWidget } from '@/components/security/TurnstileWidget';
import {
  GoogleBusinessAutocomplete,
  type ResolvedPlace,
} from '@/components/marketing/scan/GoogleBusinessAutocomplete';
import {
  trackMetaCustomEvent,
  trackMetaEvent,
} from '@/components/marketing/scan/MetaPixel';

// ────────────────────────────────────────────────────────────────────
// STEP MACHINE
// ────────────────────────────────────────────────────────────────────

type StepName =
  | 'cover'
  | 'owner'            // Q1 hard-qualify
  | 'info_invisibility' // ★ info slide — "invisible in 2/3 of your area"
  | 'trade'            // Q2
  | 'info_top3'        // ★ info slide — "Google shows three. Three."
  | 'visibility'       // Q3 self-assessed rank
  | 'info_proof'       // ★ info slide — Toronto roofer case study + testimonial
  | 'gbp'              // Q4 GBP picker (city derived from Google Places
                       //   addressComponents — so the standalone city
                       //   question that used to precede this is gone)
  | 'keyword'          // Q5 (final question — last thing before contact)
  | 'info_deliverable' // ★ info slide — what they walk away with
  | 'contact'          // email + Turnstile
  | 'loading'          // POSTing preview-init + redirecting to /share
  | 'disqualify';      // dead-end for non-operators

// Steps that count toward the visible progress bar. Cover doesn't
// count (no commitment yet); loading/disqualify aren't part of the
// quiz ladder either. Info slides DO count — the brief calls for
// presenting core information mixed with intake, and the buyer
// should feel forward momentum through each tap.
const PROGRESS_STEPS: StepName[] = [
  'owner',
  'info_invisibility',
  'trade',
  'info_top3',
  'visibility',
  'info_proof',
  'gbp',
  'keyword',
  'info_deliverable',
  'contact',
];

// ────────────────────────────────────────────────────────────────────
// TRADE OPTIONS (Q2)
// ────────────────────────────────────────────────────────────────────

type TradeOption = {
  slug: string;
  label: string;
  Icon: typeof Wrench;
};

// Verbatim Fourdots Digital "home services" verticals (per
// fourdots.io/home-services), in the same order they're listed on
// the marketing site. These ARE the ideal-customer trades for the
// downstream upsell ladder — same slug values get stamped into
// stripe_metadata.trade so cohort analysis can later split unit
// economics by vertical without separate joins.
//
// "Something else" stays as the safety-valve option: TurfMap works
// on any local business with a Google Business Profile, but a
// non-ideal trade gets routed into a softer downstream nurture
// instead of the home-services upsell sequence. We don't disqualify
// — we just measure them separately.
const TRADES: TradeOption[] = [
  { slug: 'roofing', label: 'Roofing', Icon: Home },
  { slug: 'hvac', label: 'HVAC', Icon: Flame },
  { slug: 'renovation', label: 'Renovation & Remodeling', Icon: Hammer },
  { slug: 'painting', label: 'Painting', Icon: PaintBucket },
  { slug: 'landscaping', label: 'Landscaping', Icon: Trees },
  { slug: 'insulation', label: 'Insulation', Icon: Layers },
  { slug: 'other', label: 'Something else', Icon: Briefcase },
];
// (Electrical + Pool & Spa removed 2026-06-13 — keeping the list
//  to 7 rows so the full picker fits on one mobile screen without
//  scroll. Both verticals are still served by Fourdots Digital
//  more broadly; buyers in those trades land in 'other' and route
//  to the softer nurture path.)

// ────────────────────────────────────────────────────────────────────
// VISIBILITY SELF-ASSESSMENT OPTIONS (Q3)
// Builds anticipation for the score reveal. Doesn't drive logic;
// captured into stripe_metadata for cohort analysis later.
// ────────────────────────────────────────────────────────────────────

const VISIBILITY_OPTIONS = [
  { slug: 'top', label: 'I rank #1 in my area', icon: '🏆' },
  { slug: 'mixed', label: 'I show up sometimes', icon: '🤞' },
  { slug: 'unknown', label: "I have no idea", icon: '🤷' },
  { slug: 'invisible', label: "I'm probably invisible", icon: '👻' },
];

const OWNER_OPTIONS = [
  {
    slug: 'owner',
    label: 'Yes, I own / run the business',
    sub: "I'm the operator",
    Icon: Crown,
  },
  {
    slug: 'manager',
    label: 'I run marketing for it',
    sub: 'Owner-adjacent, makes calls on this',
    Icon: Megaphone,
  },
  {
    slug: 'agency',
    label: "I'm a freelancer or agency",
    sub: 'Doing this for a client',
    Icon: Users,
  },
  {
    slug: 'no',
    label: 'No, not me',
    sub: 'Just curious / researching',
    Icon: Search,
  },
];

// ────────────────────────────────────────────────────────────────────
// FORM STATE TYPES
// ────────────────────────────────────────────────────────────────────

// (ResolvedPlace type imported above from the shared component —
// uses nullable lat/lng since some Google Place rows don't ship
// coordinates. We guard against that at submit time.)

// ────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ────────────────────────────────────────────────────────────────────

export function QuizFlow({
  searchParamsPromise,
}: {
  searchParamsPromise: Promise<{
    [key: string]: string | string[] | undefined;
  }>;
}) {
  // ─── Step machine ────────────────────────────────────────────────
  const [step, setStep] = useState<StepName>('cover');
  const [history, setHistory] = useState<StepName[]>(['cover']);

  // ─── Form state ──────────────────────────────────────────────────
  // Note: there's no standalone city/service_area state — the city
  // we use for keyword-example personalization comes from the GBP
  // pick (place.addressComponents.city), so a separate question
  // would be redundant. The GBP step now precedes the keyword step
  // so the resolved city is available by the time we render the
  // keyword input placeholder.
  const [owner, setOwner] = useState<string | null>(null);
  const [trade, setTrade] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [place, setPlace] = useState<ResolvedPlace | null>(null);
  const [email, setEmail] = useState('');
  // Buyer-typed phone — only collected when the picked Google listing
  // came back without one (service-area businesses often omit it). The
  // server requires a phone for the NAP/citation check, so we ask
  // rather than submit an empty value.
  const [phone, setPhone] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');

  // ─── Attribution (UTMs + Meta cookies) ──────────────────────────
  const [utm, setUtm] = useState({
    source: '',
    medium: '',
    campaign: '',
    content: '',
    term: '',
    gclid: '',
    fbclid: '',
  });

  useEffect(() => {
    // Hydrate UTMs from the searchParams promise. Safe to await
    // inside a useEffect — render isn't blocked.
    searchParamsPromise.then((sp) => {
      const pick = (k: string): string => {
        const v = sp[k];
        if (typeof v === 'string') return v;
        if (Array.isArray(v)) return v[0] ?? '';
        return '';
      };
      setUtm({
        source: pick('utm_source'),
        medium: pick('utm_medium'),
        campaign: pick('utm_campaign'),
        content: pick('utm_content'),
        term: pick('utm_term'),
        gclid: pick('gclid'),
        fbclid: pick('fbclid'),
      });
    });
  }, [searchParamsPromise]);

  // ─── Submit state ────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loadingMsgIdx, setLoadingMsgIdx] = useState(0);
  const LOADING_MESSAGES = useMemo(
    () => [
      'Centering the grid on your service area…',
      'Running 81 Google searches in parallel…',
      'Mapping where you appear and where you don’t…',
      'Naming the competitors taking the cells…',
      'Almost there — your TurfScore is forming…',
    ],
    []
  );

  // Rotate the loading messages every ~2s while the scan runs.
  useEffect(() => {
    if (step !== 'loading') return;
    const id = window.setInterval(() => {
      setLoadingMsgIdx((i) => Math.min(LOADING_MESSAGES.length - 1, i + 1));
    }, 2000);
    return () => window.clearInterval(id);
  }, [step, LOADING_MESSAGES.length]);

  // ─── Navigation helpers ──────────────────────────────────────────
  function goTo(next: StepName) {
    setHistory((prev) => [...prev, next]);
    setStep(next);
  }
  function goBack() {
    if (history.length <= 1) return;
    const next = history.slice(0, -1);
    setHistory(next);
    setStep(next[next.length - 1]);
    setSubmitError(null);
  }

  // ─── Progress percentage ─────────────────────────────────────────
  const progressPct = useMemo(() => {
    const idx = PROGRESS_STEPS.indexOf(step);
    if (idx < 0) return step === 'cover' ? 0 : 100;
    return Math.round(((idx + 1) / PROGRESS_STEPS.length) * 100);
  }, [step]);

  // ─── Submit handler ──────────────────────────────────────────────
  async function submitPreview() {
    if (!place || !keyword.trim() || !email.trim()) {
      setSubmitError('Missing required fields. Hit back and double-check.');
      return;
    }
    if (place.latitude === null || place.longitude === null) {
      // Google Place didn't ship coordinates. Rare but possible —
      // happens on some chain locations and brand-new GBP listings.
      // Block submission since the scan can't seed an 81-point grid
      // without a center. Buyer can hit back + pick a different
      // location.
      setSubmitError(
        "Google didn't return coordinates for that listing. Pick a different location."
      );
      return;
    }
    // When Google had no phone for the listing we asked the buyer for
    // one on the contact step — require it here too (the server's
    // phone-required check would otherwise 400 the submit).
    if (!place.phone && phone.trim().length < 7) {
      setSubmitError('Add your business phone so we can check your listing.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    goTo('loading');

    // Client-side dedup id for Meta CAPI. Server-side preview-init
    // forwards this to the Conversions API so the pixel Lead + CAPI
    // Lead dedupe correctly.
    const eventId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `evt_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;

    // Read fbp / fbc cookies for CAPI user_data matching. Best-
    // effort — if cookies aren't present (no Meta pixel load yet,
    // or buyer hard-blocks them) the server still accepts the
    // event, just with weaker attribution.
    function readCookie(name: string): string {
      if (typeof document === 'undefined') return '';
      const m = document.cookie.match(new RegExp(`(^|; )${name}=([^;]+)`));
      return m ? decodeURIComponent(m[2]) : '';
    }
    const fbp = readCookie('_fbp');
    const fbc = readCookie('_fbc');

    try {
      const body = {
        businessName: place.businessName,
        keyword: keyword.trim(),
        email: email.trim(),
        phone: place.phone || phone.trim(),
        address: place.formattedAddress,
        latitude: place.latitude,
        longitude: place.longitude,
        components: {
          street_address: place.addressComponents?.streetAddress ?? null,
          city: place.addressComponents?.city ?? null,
          region: place.addressComponents?.region ?? null,
          postcode: place.addressComponents?.postcode ?? null,
          country_code: place.addressComponents?.countryCode ?? null,
        },
        // Pin lead_source so unlock-init auto-applies MAPCHECK50 on
        // the /share unlock CTA. Same path as the existing
        // long-scroll /free-score lander (see
        // lib/score/leadSources.ts's DISCOUNTED_LEAD_SOURCES).
        lead_source: 'free_score',
        utm_source: utm.source || 'paid_traffic',
        utm_medium: utm.medium || 'lp_quizflow',
        utm_campaign: utm.campaign || undefined,
        utm_content: utm.content || undefined,
        utm_term: utm.term || undefined,
        gclid: utm.gclid || undefined,
        fbclid: utm.fbclid || undefined,
        turnstile_token: turnstileToken || undefined,
        meta_event_id: eventId,
        fbp_cookie: fbp || undefined,
        fbc_cookie: fbc || undefined,
        event_source_url:
          typeof window !== 'undefined' ? window.location.href : undefined,
        google_place_id: place.placeId,
        google_primary_type: place.primaryType ?? undefined,
        // QuizFlow-specific captures: role + trade + visibility
        // self-rating. Forwarded so /api/score/preview-init can
        // stash them in lead_orders.stripe_metadata for the daily
        // Slack recap + cohort analysis. The 'no' role routes to
        // disqualify and never reaches this submit, so we only
        // ever ship owner | manager | agency.
        role:
          owner === 'owner' || owner === 'manager' || owner === 'agency'
            ? owner
            : undefined,
        trade: trade ?? undefined,
        visibility_self_rating:
          visibility === 'top' ||
          visibility === 'mixed' ||
          visibility === 'unknown' ||
          visibility === 'invisible'
            ? visibility
            : undefined,
      };

      const res = await fetch('/api/score/preview-init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        share_url?: string;
        error?: string;
      };
      if (!res.ok || !data.share_url) {
        setSubmitting(false);
        setSubmitError(data.error || 'Something went sideways. Try again.');
        goTo('contact');
        return;
      }

      // Meta Pixel fires — share `eventId` with the matching CAPI
      // events fired server-side inside /api/score/preview-init's
      // after() block so Meta dedupes each (event_name, event_id)
      // pair. trackMetaEvent + trackMetaCustomEvent are no-ops when
      // fbq hasn't loaded; the server-side CAPI events still fire.
      //
      // BOTH events fire alongside each other:
      //   - 'Lead' — the generic standard event, backwards-compatible
      //     with the existing Ads-Manager Lead reporting.
      //   - 'FreeScoreSubmit' — purpose-built custom event the
      //     /free-score-now lander campaign optimizes against. Without
      //     a matching client-side Pixel fire, the CAPI FreeScoreSubmit
      //     lands unmatched at Meta — still counts for Custom
      //     Conversion attribution but with a weaker ad-optimization
      //     signal. Mirrors the long-scroll /free-score form's pattern
      //     in ScanIntakeForm.tsx so both lander variants emit the
      //     same conversion shape.
      const pixelParams = {
        content_name: 'TurfScan preview',
        content_category: trade ?? undefined,
      };
      trackMetaEvent('Lead', pixelParams, { eventID: eventId });
      trackMetaCustomEvent('FreeScoreSubmit', pixelParams, {
        eventID: eventId,
      });

      // Hard navigate so the /share page mounts fresh (it's a
      // server component reading the scan results from the URL).
      window.location.assign(data.share_url);
    } catch (e) {
      setSubmitting(false);
      setSubmitError(
        e instanceof Error ? e.message : 'Network hiccup. Try again.'
      );
      goTo('contact');
    }
  }

  // ─── Render ──────────────────────────────────────────────────────
  return (
    <div className="min-h-dvh w-full bg-black text-white flex items-center justify-center">
      {/* DEVICE FRAME: full-bleed on mobile, phone-shaped card on
       *  desktop (matches the Logik quizflow's 440×880 device
       *  treatment). Single column, internal scroll per step. */}
      <div
        className="
          relative w-full max-w-[440px] h-dvh max-h-[920px]
          flex flex-col overflow-hidden
          bg-[#0a0a0a]
          md:rounded-[34px] md:h-[880px]
          md:border md:border-zinc-800
          md:shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8),0_0_60px_-10px_rgba(197,255,58,0.12)]
        "
      >
        <Topbar
          progressPct={progressPct}
          canGoBack={history.length > 1 && step !== 'loading'}
          onBack={goBack}
        />

        <div className="relative flex-1 overflow-hidden">
          {step === 'cover' && (
            <CoverStep onStart={() => goTo('owner')} />
          )}
          {step === 'owner' && (
            <SingleSelectStep
              eyebrow="QUESTION 1 OF 5"
              title="Are you the one calling the shots on Google rankings?"
              subtitle="So we frame the score the right way for you."
              options={OWNER_OPTIONS}
              selected={owner}
              onSelect={(slug) => {
                setOwner(slug);
                window.setTimeout(() => {
                  if (slug === 'no') {
                    goTo('disqualify');
                  } else {
                    goTo('info_invisibility');
                  }
                }, 220);
              }}
            />
          )}
          {step === 'info_invisibility' && (
            <InfoInvisibility onContinue={() => goTo('trade')} />
          )}
          {step === 'trade' && (
            <SingleSelectStep
              eyebrow="QUESTION 2 OF 5"
              title="What do you do?"
              subtitle="So the score copy and Fix List match your category."
              options={TRADES.map((t) => ({
                slug: t.slug,
                label: t.label,
                Icon: t.Icon,
              }))}
              selected={trade}
              onSelect={(slug) => {
                setTrade(slug);
                window.setTimeout(() => goTo('info_top3'), 220);
              }}
            />
          )}
          {step === 'info_top3' && (
            <InfoTop3 onContinue={() => goTo('visibility')} />
          )}
          {step === 'visibility' && (
            <SingleSelectStep
              eyebrow="QUESTION 3 OF 5"
              title="How would you describe your current Google visibility?"
              subtitle="No wrong answer — this just calibrates the reveal."
              options={VISIBILITY_OPTIONS.map((o) => ({
                slug: o.slug,
                label: o.label,
                icon: o.icon,
              }))}
              selected={visibility}
              onSelect={(slug) => {
                setVisibility(slug);
                window.setTimeout(() => goTo('info_proof'), 220);
              }}
            />
          )}
          {step === 'info_proof' && (
            <InfoProof onContinue={() => goTo('gbp')} />
          )}
          {step === 'gbp' && (
            <GbpStep
              place={place}
              onResolved={(p) => {
                setPlace(p);
                // Auto-advance after a brief beat so the buyer sees
                // their pick land before the step transitions.
                window.setTimeout(() => goTo('keyword'), 450);
              }}
              onClear={() => setPlace(null)}
            />
          )}
          {step === 'keyword' && (
            <TextInputStep
              eyebrow="QUESTION 5 OF 5"
              title="What does someone search to find you?"
              subtitle="The keyword your highest-value customers actually type. Not your business name."
              placeholder={`e.g. ${exampleKeyword(
                trade,
                place?.addressComponents?.city ?? null
              )}`}
              value={keyword}
              onChange={setKeyword}
              onContinue={() => goTo('info_deliverable')}
              continueDisabled={keyword.trim().length < 2}
              continueLabel="Continue →"
            />
          )}
          {step === 'info_deliverable' && (
            <InfoDeliverable onContinue={() => goTo('contact')} />
          )}
          {step === 'contact' && (
            <ContactStep
              email={email}
              onEmailChange={setEmail}
              phone={phone}
              onPhoneChange={setPhone}
              onTurnstileToken={setTurnstileToken}
              onSubmit={submitPreview}
              submitting={submitting}
              submitError={submitError}
              place={place}
            />
          )}
          {step === 'loading' && (
            <LoadingStep
              message={LOADING_MESSAGES[loadingMsgIdx]}
              messageCount={LOADING_MESSAGES.length}
              currentIdx={loadingMsgIdx}
            />
          )}
          {step === 'disqualify' && <DisqualifyStep />}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// TOP BAR — progress + back button + wordmark
// ────────────────────────────────────────────────────────────────────

function Topbar({
  progressPct,
  canGoBack,
  onBack,
}: {
  progressPct: number;
  canGoBack: boolean;
  onBack: () => void;
}) {
  return (
    <div className="flex-none flex items-center gap-3 px-4 pt-4 pb-2">
      <button
        type="button"
        onClick={onBack}
        disabled={!canGoBack}
        aria-label="Back"
        className={`
          w-9 h-9 rounded-full border flex items-center justify-center
          transition-opacity
          ${canGoBack ? 'opacity-100 border-zinc-700 bg-[#0d0d0d] hover:bg-zinc-900' : 'opacity-0 pointer-events-none border-zinc-800'}
        `}
      >
        <ArrowLeft size={16} className="text-zinc-300" />
      </button>
      <div className="flex-1 h-[7px] rounded-full bg-zinc-900 overflow-hidden">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{
            width: `${progressPct}%`,
            background:
              'linear-gradient(90deg, #a9e029 0%, #c5ff3a 100%)',
            boxShadow: '0 0 12px rgba(197, 255, 58, 0.4)',
          }}
        />
      </div>
      <div className="flex-none flex items-center gap-2">
        <span
          className="w-6 h-6 rounded-md flex items-center justify-center"
          style={{ background: 'var(--color-lime, #c5ff3a)' }}
        >
          <Crosshair size={14} strokeWidth={2.25} className="text-black" />
        </span>
        <span className="font-display text-sm font-bold tracking-tight text-zinc-200">
          TurfMap
        </span>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// COVER (Step 0) — hero + trust marks + start CTA
// ────────────────────────────────────────────────────────────────────

function CoverStep({ onStart }: { onStart: () => void }) {
  return (
    <StepShell>
      <div className="flex-1 flex flex-col items-center justify-center text-center pt-2">
        {/* Score badge — TurfMap equivalent of the Logik $1,250
         *  rebate plate. Lime gradient ring around a "0–100" hint
         *  + glow. Sets up the reveal at the end. */}
        <div className="flex flex-col items-center gap-1.5 mb-7">
          <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500 font-semibold">
            Your TurfScore
          </div>
          <div
            className="font-display text-[64px] font-black leading-none tracking-[-0.04em]"
            style={{
              color: 'var(--color-lime, #c5ff3a)',
              textShadow: '0 4px 30px rgba(197, 255, 58, 0.35)',
            }}
          >
            0–100
          </div>
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-300 font-semibold">
            Free · 60 seconds · No card
          </div>
        </div>

        <h1 className="font-display text-[28px] md:text-[30px] font-bold leading-[1.08] tracking-[-0.02em] mb-3 max-w-[14ch]">
          Find out how{' '}
          <em
            className="not-italic"
            style={{
              color: '#ff4d4d',
              textShadow: '0 2px 22px rgba(255, 77, 77, 0.35)',
            }}
          >
            invisible
          </em>{' '}
          you are on Google Maps.
        </h1>
        <p className="text-zinc-400 text-[15px] leading-[1.55] mb-7 max-w-[32ch]">
          We scan 81 cells around your service area and show you, cell by cell,
          where you appear and where you don&rsquo;t.
        </p>

        <div className="flex flex-col gap-2 w-full max-w-[300px] mb-6">
          <TrustBadge
            icon={<Sparkles size={16} className="text-black" />}
            text="Real Google data — not estimates"
          />
          {/* Replaced "Built by Fourdots Digital" with the buyer's
           *  actual deliverable. "Built by an agency" is true but
           *  doesn't compel — what they leave with is the Fix List. */}
          <TrustBadge
            icon={<Crosshair size={16} className="text-black" />}
            text="AI Coach: 3 prioritized fixes"
          />
          <TrustBadge
            icon={<Compass size={16} className="text-black" />}
            text="60-second delivery, no card"
          />
        </div>
      </div>

      <FooterBar>
        <CtaButton onClick={onStart}>
          Check my visibility (60 sec)
          <ArrowRight size={16} className="ml-1.5 -mr-0.5" />
        </CtaButton>
        <p className="text-center text-[11.5px] text-zinc-500 mt-2.5">
          We&rsquo;ll never share your email.
        </p>
      </FooterBar>
    </StepShell>
  );
}

function TrustBadge({
  icon,
  text,
}: {
  icon: React.ReactNode;
  text: string;
}) {
  return (
    <div className="flex items-center justify-center gap-2.5 bg-[#0d0d0d] border border-zinc-800 rounded-xl px-4 py-2.5">
      <span
        className="w-[22px] h-[22px] rounded-md flex items-center justify-center flex-none"
        style={{ background: 'var(--color-lime, #c5ff3a)' }}
      >
        {icon}
      </span>
      <span className="text-[13.5px] font-semibold text-zinc-200 leading-tight">
        {text}
      </span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// SINGLE-SELECT STEP (Q1, Q2, Q3) — option cards with icon + tick
// ────────────────────────────────────────────────────────────────────

type SingleSelectOption = {
  slug: string;
  label: string;
  sub?: string;
  Icon?: typeof Wrench;
  icon?: string; // emoji fallback
};

function SingleSelectStep({
  eyebrow,
  title,
  subtitle,
  options,
  selected,
  onSelect,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  options: SingleSelectOption[];
  selected: string | null;
  onSelect: (slug: string) => void;
}) {
  return (
    <StepShell>
      <StepHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />
      <div className="flex flex-col gap-2.5 mt-2">
        {options.map((opt) => {
          const isSel = selected === opt.slug;
          return (
            <button
              key={opt.slug}
              type="button"
              onClick={() => onSelect(opt.slug)}
              className={`
                w-full text-left flex items-center gap-3.5 px-4 py-3.5 rounded-2xl
                border transition-[transform,background,border-color] duration-150
                active:scale-[0.985]
                ${
                  isSel
                    ? 'border-[color:var(--color-lime,#c5ff3a)] bg-[rgba(197,255,58,0.06)]'
                    : 'border-zinc-800 bg-[#0d0d0d] hover:border-zinc-700'
                }
              `}
            >
              <span
                className="w-11 h-11 rounded-xl flex items-center justify-center flex-none"
                style={{
                  background: isSel
                    ? 'var(--color-lime, #c5ff3a)'
                    : 'rgba(197, 255, 58, 0.08)',
                }}
              >
                {opt.Icon ? (
                  <opt.Icon
                    size={22}
                    className={isSel ? 'text-black' : ''}
                    style={
                      isSel
                        ? undefined
                        : { color: 'var(--color-lime, #c5ff3a)' }
                    }
                  />
                ) : (
                  <span className="text-[22px] leading-none">{opt.icon}</span>
                )}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block font-semibold text-[15.5px] leading-tight text-zinc-100">
                  {opt.label}
                </span>
                {opt.sub && (
                  <span className="block text-[12.5px] text-zinc-500 mt-0.5">
                    {opt.sub}
                  </span>
                )}
              </span>
              <span
                className={`
                  w-6 h-6 rounded-full border-2 flex items-center justify-center flex-none
                  transition-colors duration-150
                  ${isSel ? 'border-[color:var(--color-lime,#c5ff3a)]' : 'border-zinc-700'}
                `}
                style={{
                  background: isSel
                    ? 'var(--color-lime, #c5ff3a)'
                    : 'transparent',
                }}
              >
                {isSel && <Check size={14} className="text-black" strokeWidth={3} />}
              </span>
            </button>
          );
        })}
      </div>
    </StepShell>
  );
}

// ────────────────────────────────────────────────────────────────────
// TEXT INPUT STEP (Q4, Q5)
// ────────────────────────────────────────────────────────────────────

function TextInputStep({
  eyebrow,
  title,
  subtitle,
  placeholder,
  value,
  onChange,
  onContinue,
  continueDisabled,
  continueLabel,
  autoComplete,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onContinue: () => void;
  continueDisabled: boolean;
  continueLabel: string;
  autoComplete?: string;
}) {
  return (
    <StepShell>
      <StepHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="
          w-full bg-[#0d0d0d] border-2 border-zinc-800 rounded-xl
          px-4 py-3.5 text-[16px] text-zinc-100 placeholder:text-zinc-600
          focus:outline-none focus:border-[color:var(--color-lime,#c5ff3a)]
          focus:shadow-[0_0_0_4px_rgba(197,255,58,0.12)]
          transition-[border-color,box-shadow] duration-150
        "
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !continueDisabled) {
            onContinue();
          }
        }}
        autoFocus
      />
      <FooterBar>
        <CtaButton onClick={onContinue} disabled={continueDisabled}>
          {continueLabel}
        </CtaButton>
      </FooterBar>
    </StepShell>
  );
}

// ────────────────────────────────────────────────────────────────────
// GBP STEP (Q6) — Google Places autocomplete
// ────────────────────────────────────────────────────────────────────

function GbpStep({
  place,
  onResolved,
  onClear,
}: {
  place: ResolvedPlace | null;
  onResolved: (p: ResolvedPlace) => void;
  onClear: () => void;
}) {
  return (
    <StepShell>
      <StepHeader
        eyebrow="QUESTION 4 OF 5"
        title="Pick your business on Google"
        subtitle="So we lock the right location and pull your Google listing. Pick from the dropdown — no address needed."
      />
      <GoogleBusinessAutocomplete
        placeholder="Type your business name…"
        onResolved={(p) => {
          onResolved(p);
        }}
        onClear={() => {
          onClear();
        }}
      />
      {place && (
        <div className="mt-4 rounded-xl border border-[color:var(--color-lime,#c5ff3a)] bg-[rgba(197,255,58,0.06)] p-3.5">
          <div className="flex items-start gap-2.5">
            <span className="text-[16px] leading-none mt-0.5">📍</span>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-zinc-100 text-[14px] leading-tight">
                {place.businessName}
              </div>
              <div className="text-[12px] text-zinc-400 mt-1 leading-snug">
                {/* Service-area businesses hide their street address on
                 *  Google, so formattedAddress comes back empty. Fall
                 *  back to the city/region, then a plain-language note
                 *  so the card never renders a blank line. */}
                {place.formattedAddress?.trim() ||
                  [place.addressComponents?.city, place.addressComponents?.region]
                    .filter(Boolean)
                    .join(', ') ||
                  'Service-area business — no public address on Google'}
              </div>
            </div>
          </div>
        </div>
      )}
    </StepShell>
  );
}

// ────────────────────────────────────────────────────────────────────
// CONTACT STEP (the conversion event)
// ────────────────────────────────────────────────────────────────────

function ContactStep({
  email,
  onEmailChange,
  phone,
  onPhoneChange,
  onTurnstileToken,
  onSubmit,
  submitting,
  submitError,
  place,
}: {
  email: string;
  onEmailChange: (v: string) => void;
  phone: string;
  onPhoneChange: (v: string) => void;
  onTurnstileToken: (token: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  submitError: string | null;
  place: ResolvedPlace | null;
}) {
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  // Google omits the phone on many service-area listings. When it did,
  // collect it here so the scan's NAP check has a number to verify.
  const needsPhone = !place?.phone;
  const valid = emailValid && (!needsPhone || phone.trim().length >= 7);

  return (
    <StepShell>
      <StepHeader
        eyebrow="ONE LAST STEP"
        title="Where do we send your TurfScore?"
        subtitle="60-second scan kicks off as soon as you hit send."
      />
      {place && (
        <p className="text-[12.5px] text-zinc-500 mb-3">
          Scanning <span className="text-zinc-300 font-semibold">{place.businessName}</span>.
        </p>
      )}
      <label
        htmlFor="quizflow-email"
        className="block text-[13px] font-semibold text-zinc-300 mb-1.5"
      >
        Email
      </label>
      <div className="relative">
        <Mail
          size={16}
          className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-600"
        />
        <input
          id="quizflow-email"
          type="email"
          inputMode="email"
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          placeholder="you@business.com"
          autoComplete="email"
          autoFocus
          className="
            w-full bg-[#0d0d0d] border-2 border-zinc-800 rounded-xl
            pl-10 pr-4 py-3.5 text-[16px] text-zinc-100 placeholder:text-zinc-600
            focus:outline-none focus:border-[color:var(--color-lime,#c5ff3a)]
            focus:shadow-[0_0_0_4px_rgba(197,255,58,0.12)]
            transition-[border-color,box-shadow] duration-150
          "
        />
      </div>

      {/* Conditional phone — only when the picked Google listing had no
       *  phone. The scan's NAP/citation check needs a number to verify,
       *  and the server requires it, so we ask rather than submit empty. */}
      {needsPhone && (
        <div className="mt-4">
          <label
            htmlFor="quizflow-phone"
            className="block text-[13px] font-semibold text-zinc-300 mb-1.5"
          >
            Business phone
          </label>
          <div className="relative">
            <Phone
              size={16}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-600"
            />
            <input
              id="quizflow-phone"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => onPhoneChange(e.target.value)}
              placeholder="(416) 555-1234"
              autoComplete="tel"
              className="
                w-full bg-[#0d0d0d] border-2 border-zinc-800 rounded-xl
                pl-10 pr-4 py-3.5 text-[16px] text-zinc-100 placeholder:text-zinc-600
                focus:outline-none focus:border-[color:var(--color-lime,#c5ff3a)]
                focus:shadow-[0_0_0_4px_rgba(197,255,58,0.12)]
                transition-[border-color,box-shadow] duration-150
              "
            />
          </div>
          <p className="mt-1.5 text-[11.5px] text-zinc-500 leading-snug">
            Google didn&rsquo;t list a phone for your business — add it so we
            can check your listing across directories.
          </p>
        </div>
      )}

      {/* Cloudflare Turnstile site key — read from the public env
       *  var that's already wired into the rest of the funnel
       *  (ScanIntakeForm.tsx:182 uses the same one). Without this,
       *  TurnstileWidget short-circuits to render-nothing + empty
       *  token, which is exactly what was producing the
       *  "Bot-protection check is required" submit error: the
       *  server's TURNSTILE_SECRET_KEY is set so verification IS
       *  enforced, but the client wasn't shipping a token because
       *  the widget never rendered. */}
      {process.env.NEXT_PUBLIC_TURNSTILE_SITEKEY ? (
        <div className="mt-4">
          <p className="text-[11px] uppercase tracking-[0.18em] font-mono text-zinc-500 mb-1.5">
            Quick bot check
          </p>
          <TurnstileWidget
            siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITEKEY}
            onToken={onTurnstileToken}
          />
        </div>
      ) : null}

      {submitError && (
        <p className="mt-3 text-[12.5px] text-red-400 leading-snug">
          {submitError}
        </p>
      )}

      <FooterBar>
        <CtaButton onClick={onSubmit} disabled={!valid || submitting}>
          {submitting ? 'Scanning…' : 'Run my free TurfScan →'}
        </CtaButton>
        <p className="text-center text-[11.5px] text-zinc-500 mt-2.5 leading-snug">
          By submitting, you agree to receive your TurfScore by email.
          We never share it. Unsubscribe anytime.
        </p>
      </FooterBar>
    </StepShell>
  );
}

// ────────────────────────────────────────────────────────────────────
// LOADING STEP — scan-running state with rotating messaging
// ────────────────────────────────────────────────────────────────────

function LoadingStep({
  message,
  messageCount,
  currentIdx,
}: {
  message: string;
  messageCount: number;
  currentIdx: number;
}) {
  const progressPct = Math.round(((currentIdx + 1) / messageCount) * 100);
  return (
    <StepShell>
      <div className="flex-1 flex flex-col items-center justify-center text-center px-3">
        <div
          className="w-[74px] h-[74px] rounded-full border-[6px] mb-7"
          style={{
            borderColor: '#1a1a1a',
            borderTopColor: 'var(--color-lime, #c5ff3a)',
            animation: 'tm-spin 0.9s linear infinite',
          }}
        />
        <p className="font-display font-semibold text-[19px] text-zinc-100 mb-2 transition-opacity duration-300 max-w-[28ch] leading-tight">
          {message}
        </p>
        <p className="text-zinc-500 text-[13px]">
          81 cells. ~30–60 seconds.
        </p>
        <div className="mt-5 w-[200px] h-1.5 rounded-full bg-zinc-900 overflow-hidden">
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{
              width: `${progressPct}%`,
              background: 'var(--color-lime, #c5ff3a)',
            }}
          />
        </div>
      </div>
      <style jsx>{`
        @keyframes tm-spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </StepShell>
  );
}

// ────────────────────────────────────────────────────────────────────
// DISQUALIFY STEP — graceful dead-end for non-operators
// ────────────────────────────────────────────────────────────────────

function DisqualifyStep() {
  return (
    <StepShell>
      <div className="flex-1 flex flex-col items-center justify-center text-center px-3">
        <div
          className="w-[88px] h-[88px] rounded-full flex items-center justify-center mb-5"
          style={{ background: '#0d0d0d', border: '2px solid #27272a' }}
        >
          <Compass size={36} className="text-zinc-500" />
        </div>
        <h1 className="font-display font-bold text-[26px] leading-tight tracking-tight text-zinc-100 mb-3 max-w-[18ch]">
          TurfMap is built for the operator.
        </h1>
        <p className="text-zinc-400 text-[15px] leading-[1.55] mb-7 max-w-[30ch]">
          The score only matters if you can act on the Fix List. If you&rsquo;re
          researching for a business owner, forward them this link.
        </p>
        <Link
          href="/"
          className="text-zinc-400 hover:text-zinc-200 underline underline-offset-4 text-[13.5px] font-mono"
        >
          See what TurfMap does →
        </Link>
      </div>
    </StepShell>
  );
}

// ────────────────────────────────────────────────────────────────────
// INFO SLIDES — interleaved between intake questions per the brief.
//
// Each presents a single high-conversion idea from /free-score, paired
// with a small visual beat (mini-grid, top-3 illustration, testimonial
// card) so the buyer's tap-tap-tap rhythm doesn't fall into a wall
// of text. Continue CTA advances the step machine.
// ────────────────────────────────────────────────────────────────────

/** Shared layout primitive for info slides — eyebrow + headline +
 *  body + visual + Continue button + StepShell scroll container. */
function InfoSlide({
  eyebrow,
  headline,
  body,
  visual,
  ctaLabel = 'Continue →',
  onContinue,
}: {
  eyebrow: string;
  headline: React.ReactNode;
  body: React.ReactNode;
  visual?: React.ReactNode;
  ctaLabel?: string;
  onContinue: () => void;
}) {
  return (
    <StepShell>
      <div className="flex-1 flex flex-col">
        <div
          className="text-[11px] font-mono font-bold tracking-[0.18em] mb-2.5"
          style={{ color: 'var(--color-lime, #c5ff3a)' }}
        >
          {eyebrow}
        </div>
        <h1 className="font-display text-[24px] md:text-[26px] font-bold leading-[1.18] tracking-tight text-zinc-100 mb-3">
          {headline}
        </h1>
        <div className="text-zinc-400 text-[14.5px] leading-[1.55] mb-5">
          {body}
        </div>
        {visual && <div className="mb-2">{visual}</div>}
      </div>
      <FooterBar>
        <CtaButton onClick={onContinue}>{ctaLabel}</CtaButton>
      </FooterBar>
    </StepShell>
  );
}

// ─── Info slide 1 — "two-thirds invisible" (after owner Q1) ─────────

function InfoInvisibility({ onContinue }: { onContinue: () => void }) {
  return (
    <InfoSlide
      eyebrow="WHY THIS MATTERS"
      headline={
        <>
          Most local businesses are{' '}
          <em
            className="not-italic"
            style={{ color: '#ff4d4d' }}
          >
            invisible
          </em>{' '}
          in two-thirds of their service area.
        </>
      }
      body={
        <>
          You probably rank #1 from your office. But Google centers
          searches around the searcher — so two miles away, you&rsquo;re
          often nowhere.
          <br />
          <br />
          Your free TurfScore (0&ndash;100) tells you exactly how
          visible you are across your{' '}
          <strong className="text-zinc-200 font-semibold">whole</strong>{' '}
          service area — block by block.
        </>
      }
      visual={<MiniInvisibilityGrid />}
      ctaLabel="Tell me more →"
      onContinue={onContinue}
    />
  );
}

/** 5×5 stylized grid — most cells red (invisible) with one lime
 *  highlighted cell representing "you" right at the center (where
 *  you searched). Makes the abstract idea visual at a glance. */
function MiniInvisibilityGrid() {
  // Deterministic pattern: 25 cells, center = lime (the buyer's
  // office), most others red (invisible), a few zinc (some
  // visibility). Hand-tuned for visual rhythm, not random.
  const CELLS: ('lime' | 'red' | 'dim')[] = [
    'red', 'red', 'red', 'red', 'red',
    'red', 'red', 'red', 'dim', 'red',
    'red', 'red', 'lime', 'red', 'red',
    'red', 'dim', 'red', 'red', 'red',
    'red', 'red', 'red', 'red', 'red',
  ];
  return (
    <div className="grid grid-cols-5 gap-1.5 max-w-[200px] mx-auto mb-2">
      {CELLS.map((kind, i) => {
        const isLime = kind === 'lime';
        const isRed = kind === 'red';
        return (
          <div
            key={i}
            className="aspect-square rounded-full"
            style={{
              background: isLime
                ? 'radial-gradient(circle, rgba(197,255,58,0.65) 0%, rgba(197,255,58,0.18) 60%, transparent 100%)'
                : isRed
                  ? 'radial-gradient(circle, rgba(239,68,68,0.55) 0%, rgba(239,68,68,0.10) 60%, transparent 100%)'
                  : 'radial-gradient(circle, rgba(150,150,150,0.30) 0%, transparent 70%)',
              border: isLime
                ? '1px solid rgba(197,255,58,0.5)'
                : isRed
                  ? '1px solid rgba(239,68,68,0.30)'
                  : '1px solid rgba(120,120,120,0.20)',
            }}
          />
        );
      })}
    </div>
  );
}

// ─── Info slide 2 — "Google shows three" (after trade Q2) ───────────

function InfoTop3({ onContinue }: { onContinue: () => void }) {
  return (
    <InfoSlide
      eyebrow="THE GOOGLE MAPS TRUTH"
      headline={
        <>
          If you&rsquo;re not in the top{' '}
          <em
            className="not-italic"
            style={{ color: 'var(--color-lime, #c5ff3a)' }}
          >
            three
          </em>
          , you&rsquo;re{' '}
          <em
            className="not-italic"
            style={{ color: '#ff4d4d' }}
          >
            invisible
          </em>
          .
        </>
      }
      body={
        <>
          Google&rsquo;s local map pack shows three businesses.
          Three. Not ten, not five.
          <br />
          <br />
          For a given block, if you&rsquo;re not one of those three,
          your competitor is taking that call.
        </>
      }
      visual={<MapPackVisual />}
      ctaLabel="Got it →"
      onContinue={onContinue}
    />
  );
}

/** Stylized Google Local 3-pack illustration — ports the visual
 *  language from the homepage's MapPackDemo (components/marketing/
 *  MapPackDemo.tsx) so the buyer sees a consistent vocabulary
 *  across surfaces: rank chip colors (#1 lime / #2 yellow / #3
 *  orange), eyebrow + pin-icon header, mini SVG map with three
 *  positioned pins, listing rows with real-looking business names
 *  + star ratings + reviews count + category, and a bottom-caption
 *  punchline.
 *
 *  Two adaptations vs. the homepage version:
 *    1. Sized down for the 440px-wide device frame (tighter padding,
 *       smaller fonts).
 *    2. ★ Appends a fourth row — the "you — invisible to this
 *       searcher" red card — which is the whole point of the slide.
 *       The first three rows show what Google returns; the fourth
 *       drives the punchline home before the buyer continues. */
const PACK_ENTRIES: {
  rank: 1 | 2 | 3;
  name: string;
  rating: number;
  reviews: number;
  category: string;
}[] = [
  { rank: 1, name: 'Atlas Plumbing & Drain', rating: 4.8, reviews: 142, category: 'Plumber' },
  { rank: 2, name: 'Quick Pipe Pros', rating: 4.6, reviews: 87, category: 'Plumber' },
  { rank: 3, name: 'Maple City Plumbers', rating: 4.4, reviews: 53, category: 'Plumber' },
];

const RANK_COLORS = {
  1: '#c5ff3a', // lime
  2: '#e8e54a', // yellow
  3: '#ff9f3a', // orange
} as const;

function MapPackVisual() {
  return (
    <div
      className="rounded-lg border overflow-hidden mx-auto max-w-[330px]"
      style={{
        background: 'var(--color-card, #0d0d0d)',
        borderColor: 'var(--color-border-bright, #3f3f46)',
        boxShadow: '0 12px 36px rgba(197, 255, 58, 0.08)',
      }}
    >
      {/* Eyebrow header */}
      <div
        className="px-3 py-2 flex items-center justify-between border-b"
        style={{ borderColor: 'var(--color-border, #27272a)' }}
      >
        <div className="text-[9px] uppercase tracking-[0.2em] font-mono font-semibold text-zinc-500">
          Google&apos;s local 3-pack
        </div>
        <MapPin size={11} className="text-zinc-600" />
      </div>

      {/* Stylized mini map — pure SVG, three rank-colored pins */}
      <div className="px-3 pt-2.5">
        <div
          className="relative rounded-md overflow-hidden"
          style={{
            background: '#0d130a',
            border: '1px solid var(--color-border, #27272a)',
            height: 80,
          }}
        >
          <svg
            viewBox="0 0 280 110"
            className="absolute inset-0 w-full h-full"
            preserveAspectRatio="xMidYMid slice"
            aria-hidden
          >
            <g stroke="#1f1f1f" strokeWidth="1" fill="none">
              <path d="M0 35 L280 30" />
              <path d="M0 75 L280 78" />
              <path d="M60 0 L65 110" />
              <path d="M160 0 L155 110" />
              <path d="M230 0 L232 110" />
            </g>
            <path
              d="M0 55 L280 52"
              stroke="#2a2a1a"
              strokeWidth="1.5"
              fill="none"
            />
            <path
              d="M210 90 Q240 85 270 95 L280 110 L210 110 Z"
              fill="#c5ff3a"
              fillOpacity="0.08"
            />
            <g>
              {[
                { x: 95, y: 45, color: RANK_COLORS[1] },
                { x: 145, y: 60, color: RANK_COLORS[2] },
                { x: 185, y: 40, color: RANK_COLORS[3] },
              ].map((pin, i) => (
                <g key={i}>
                  <circle
                    cx={pin.x}
                    cy={pin.y + 1}
                    r={6}
                    fill="rgba(0,0,0,0.6)"
                  />
                  <circle cx={pin.x} cy={pin.y} r={6} fill={pin.color} />
                  <circle cx={pin.x} cy={pin.y} r={2} fill="#0a0a0a" />
                </g>
              ))}
            </g>
          </svg>
        </div>
      </div>

      {/* Three real-looking listing rows */}
      <ul className="px-3 py-2.5 space-y-2">
        {PACK_ENTRIES.map((entry) => (
          <li
            key={entry.name}
            className="flex items-start gap-2 text-[12px] leading-tight"
          >
            <div
              className="flex-none w-[22px] h-[22px] rounded-md flex items-center justify-center font-display font-bold text-[10.5px]"
              style={{
                background: RANK_COLORS[entry.rank],
                color: '#0a0a0a',
              }}
              aria-hidden
            >
              {entry.rank}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-zinc-100 truncate text-[12.5px]">
                {entry.name}
              </div>
              <div className="flex items-center gap-1.5 text-[10.5px] text-zinc-500 mt-0.5">
                <Star
                  size={9}
                  fill="#f5c842"
                  stroke="#f5c842"
                  className="flex-none"
                />
                <span className="text-zinc-300 font-mono">
                  {entry.rating.toFixed(1)}
                </span>
                <span className="font-mono">({entry.reviews})</span>
                <span className="text-zinc-700">·</span>
                <span className="truncate">{entry.category}</span>
              </div>
            </div>
          </li>
        ))}

        {/* ★ Fourth row — the punchline. Same row geometry as the
         *  three pack entries above so the buyer reads it as part
         *  of the same list, but in red with a "?" badge to signal
         *  the absence. */}
        <li
          className="flex items-start gap-2 text-[12px] leading-tight pt-2 mt-1 border-t"
          style={{ borderColor: 'var(--color-border, #27272a)' }}
        >
          <div
            className="flex-none w-[22px] h-[22px] rounded-md flex items-center justify-center font-display font-bold text-[11.5px] text-white"
            style={{ background: '#ff4d4d' }}
            aria-hidden
          >
            ?
          </div>
          <div className="min-w-0 flex-1">
            <div
              className="font-semibold text-[12.5px] leading-tight"
              style={{ color: '#ff4d4d' }}
            >
              You
            </div>
            <div className="text-[10.5px] text-zinc-500 mt-0.5 leading-snug">
              Invisible to this searcher.
            </div>
          </div>
        </li>
      </ul>

      {/* Bottom punchline caption */}
      <div
        className="px-3 py-2.5 border-t text-[10.5px] text-zinc-500 leading-snug"
        style={{
          borderColor: 'var(--color-border, #27272a)',
          background: '#0d0d0d',
        }}
      >
        These 3 businesses change{' '}
        <span className="text-zinc-300 font-semibold">
          every time the searcher moves
        </span>{' '}
        — even by a block. TurfMap measures all 81.
      </div>
    </div>
  );
}

// ─── Info slide 3 — Oklahoma case study + testimonial (after Q3) ────

function InfoProof({ onContinue }: { onContinue: () => void }) {
  return (
    <InfoSlide
      eyebrow="WHAT WE'VE SEEN"
      headline={
        <>
          A roofer in Toronto thought they ranked{' '}
          <em
            className="not-italic"
            style={{ color: 'var(--color-lime, #c5ff3a)' }}
          >
            #1
          </em>
          .
        </>
      }
      body={
        <>
          When we scanned their territory,{' '}
          <strong className="font-semibold" style={{ color: '#ff4d4d' }}>
            68% of their city
          </strong>{' '}
          couldn&rsquo;t find them in the top 3.
          <br />
          <br />
          Same business. Same listing. Different blocks, different
          outcomes.
        </>
      }
      visual={<TestimonialQuoteCard />}
      ctaLabel="Show me mine →"
      onContinue={onContinue}
    />
  );
}

/** Compact testimonial card — single quote from the painting
 *  operator (verbatim from /free-score) with the lime accent
 *  treatment that already carries social-proof weight in the
 *  rest of the funnel. */
function TestimonialQuoteCard() {
  return (
    <div
      className="relative rounded-xl border p-4 pl-9 mt-1"
      style={{
        background: 'var(--color-card-glow, #141414)',
        borderColor: 'rgba(197, 255, 58, 0.35)',
        boxShadow: '0 0 22px rgba(197, 255, 58, 0.10)',
      }}
    >
      <div
        className="font-display text-[42px] font-black leading-none absolute -top-0.5 left-3 select-none"
        style={{ color: 'var(--color-lime, #c5ff3a)' }}
        aria-hidden="true"
      >
        &ldquo;
      </div>
      <blockquote className="text-[13.5px] text-zinc-100 leading-relaxed">
        TurfMap caught a GBP category mismatch we&rsquo;d missed for 18
        months. Fixed it the same day.
      </blockquote>
      <p className="mt-2.5 text-[10.5px] font-mono text-zinc-500 leading-tight">
        — Painting operator, Greater Toronto Area
      </p>
    </div>
  );
}

// ─── Info slide 4 — "what you'll get" (after keyword Q5) ────────────

function InfoDeliverable({ onContinue }: { onContinue: () => void }) {
  return (
    <InfoSlide
      eyebrow="WHAT WE'LL GENERATE FOR YOU"
      headline={
        <>
          Your TurfScore, full heatmap, competitor analysis, and{' '}
          <em
            className="not-italic"
            style={{ color: 'var(--color-lime, #c5ff3a)' }}
          >
            3 prioritized fixes
          </em>{' '}
          to start claiming your territory.
        </>
      }
      body={
        <>
          The free preview reveals your TurfScore and confirms there
          are competitors taking calls in your area. Unlock the rest
          when you want the full picture.
        </>
      }
      visual={<DeliverableChecklist />}
      ctaLabel="Show me my score →"
      onContinue={onContinue}
    />
  );
}

/** Four-item checklist showing the full deliverable suite (TurfScore
 *  / heatmap / competitor analysis / Fix List). Each row also carries
 *  a small "free preview" or "unlock" tag so the buyer knows what's
 *  visible at $0 vs. behind the $49 unlock CTA on /share — surfaces
 *  the value ladder without burying it. */
function DeliverableChecklist() {
  const ITEMS: { title: string; body: string; gate: 'free' | 'unlock' }[] = [
    {
      title: 'Your TurfScore (0–100)',
      body: 'One number across 81 real Google searches.',
      gate: 'free',
    },
    {
      title: 'Full block-by-block heatmap',
      body: 'Exactly which cells you own — and which you don’t.',
      gate: 'unlock',
    },
    {
      title: 'Competitor analysis',
      body: 'The businesses taking calls in the cells you’re missing.',
      gate: 'unlock',
    },
    {
      title: '3 prioritized fixes',
      body: 'AI Coach Fix List, written from your real audit data.',
      gate: 'unlock',
    },
  ];
  return (
    <div className="flex flex-col gap-2 max-w-[330px] mx-auto">
      {ITEMS.map((it, i) => (
        <div
          key={i}
          className="flex items-start gap-2.5 rounded-xl border border-zinc-800 bg-[#0d0d0d] px-3.5 py-3"
        >
          <span
            className="w-6 h-6 rounded-md flex items-center justify-center flex-none mt-0.5"
            style={{ background: 'var(--color-lime, #c5ff3a)' }}
          >
            <Check size={14} className="text-black" strokeWidth={3} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-[13.5px] text-zinc-100 leading-tight">
                {it.title}
              </span>
              <span
                className={`
                  text-[9px] font-mono font-bold uppercase tracking-[0.12em]
                  px-1.5 py-0.5 rounded
                `}
                style={
                  it.gate === 'free'
                    ? {
                        background: 'rgba(197,255,58,0.12)',
                        color: 'var(--color-lime, #c5ff3a)',
                      }
                    : {
                        background: 'rgba(160,160,160,0.10)',
                        color: '#a1a1aa',
                      }
                }
              >
                {it.gate === 'free' ? 'Free' : 'Unlock'}
              </span>
            </div>
            <div className="text-[12px] text-zinc-500 leading-snug mt-0.5">
              {it.body}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// SHARED LAYOUT PRIMITIVES
// ────────────────────────────────────────────────────────────────────

function StepShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col px-5 pt-3 pb-5 overflow-y-auto">
      {children}
    </div>
  );
}

function StepHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-5">
      <div
        className="text-[11px] font-mono font-bold tracking-[0.18em] mb-2.5"
        style={{ color: 'var(--color-lime, #c5ff3a)' }}
      >
        {eyebrow}
      </div>
      <h1 className="font-display text-[24px] font-bold leading-[1.18] tracking-tight text-zinc-100 mb-2">
        {title}
      </h1>
      {subtitle && (
        <p className="text-zinc-400 text-[14.5px] leading-[1.5]">
          {subtitle}
        </p>
      )}
    </div>
  );
}

function FooterBar({ children }: { children: React.ReactNode }) {
  return <div className="mt-auto pt-4">{children}</div>;
}

function CtaButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`
        w-full rounded-xl py-4 font-display font-bold text-[16.5px] tracking-tight
        flex items-center justify-center
        transition-[opacity,transform,background-color] duration-150
        active:scale-[0.99]
        ${
          disabled
            ? 'opacity-40 cursor-not-allowed'
            : 'opacity-100 hover:brightness-[1.05]'
        }
      `}
      style={{
        background: 'var(--color-lime, #c5ff3a)',
        color: '#000',
      }}
    >
      {children}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────────

function exampleKeyword(trade: string | null, city: string | null): string {
  // Aligned with the Fourdots "home services" trade slugs above.
  // Each example is the canonical search a high-value customer of
  // that vertical would actually type. Falls back to "home services
  // <city>" for the 'other' bucket — generic enough that the buyer
  // can replace it without confusion.
  const c = (city ?? '').trim() || 'toronto';
  const tradeKw =
    trade === 'roofing'
      ? 'roof repair'
      : trade === 'hvac'
        ? 'hvac repair'
        : trade === 'renovation'
          ? 'home renovation'
          : trade === 'painting'
            ? 'house painter'
            : trade === 'landscaping'
              ? 'lawn care'
              : trade === 'insulation'
                ? 'attic insulation'
                : 'home services';
  return `${tradeKw} ${c.toLowerCase()}`;
}
