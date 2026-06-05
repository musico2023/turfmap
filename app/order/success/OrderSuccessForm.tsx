'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Loader2, Sparkles } from 'lucide-react';
import {
  AddressAutocomplete,
  type AddressFields,
} from '@/components/turfmap/AddressAutocomplete';
import { CalEmbed } from '@/components/turfmap/CalEmbed';
import { OnboardingWizard } from '@/components/turfmap/OnboardingWizard';
import { PulseAttachPanel } from '@/components/turfmap/PulseAttachPanel';
import { AuditUpgradePanel } from '@/components/marketing/AuditUpgradePanel';
import { SuccessBurst } from '@/components/animations/SuccessBurst';
import { ScanProgress } from '@/components/turfmap/ScanProgress';
import type { OnboardingStep } from '@/lib/supabase/types';

/**
 * Post-checkout business-details form.
 *
 * Stripe paid → land here → fill business name / address / keyword(s) /
 * email / phone → submit → server creates a `lead_orders` row, kicks
 * the existing scan-trigger pipeline, sends a Resend confirmation,
 * and shows a "we're scanning" success state.
 *
 * For now this is a stub:
 *   - the form layout, validation, and busy-state UX is real
 *   - submission posts to /api/orders/fulfill (route TBD in next PR)
 *   - if that route doesn't exist yet we surface a clear inline error
 *
 * Trade-off accepted on purpose: we ship the form first so the
 * payment-to-scan flow has a believable handoff *now*, and wire the
 * server-side fulfillment in a follow-up commit when we have the
 * Stripe webhook + lead_orders table designed.
 */
export function OrderSuccessForm({
  tier,
  sessionId,
  keywordCount,
  prefillEmail,
  stripeCustomerId,
  attachState,
  attachPublicId,
  attachOnboardingStep,
  isAuditUpgrade,
  savedCard,
  prospectId,
  cohort,
  amountTotalCents,
  prefillKeyword,
  prefilledIntake,
  scoreUnlock,
}: {
  tier: string | null;
  sessionId: string | null;
  keywordCount: number;
  /** Buyer email captured server-side from the Stripe Checkout session.
   *  When non-null, used to pre-fill the email field — saves the
   *  buyer typing it again. They can still edit if they want a
   *  different delivery address. */
  prefillEmail: string | null;
  /** Stripe customer id from the original one-time purchase. Forwarded
   *  to the Pulse-attach panel so the trial subscription pre-binds to
   *  the same customer (no email re-entry on Stripe). Null when the
   *  session lookup couldn't recover it (e.g. Stripe not configured). */
  stripeCustomerId: string | null;
  /** Round-trip flag from the Pulse-attach Stripe redirect. When
   *  'success', the success card surfaces a confirmation banner +
   *  hides the attach panel. When 'cancelled', the attach panel
   *  remains visible so the buyer can retry. Null when the buyer
   *  hasn't engaged with the attach flow. */
  attachState: 'success' | 'cancelled' | null;
  /** Server-resolved client public_id for the attach return path.
   *  Set when attachState is non-null (the buyer is returning from
   *  Stripe Pulse-attach and shouldn't re-fill the form). Null on
   *  the initial purchase flow. */
  attachPublicId: string | null;
  /** Server-resolved onboarding_step when the buyer is returning
   *  from a successful Pulse trial-attach. When set, the success
   *  state replaces the static "Pulse trial active" banner with the
   *  inline OnboardingWizard so the buyer drops straight into GBP
   *  confirmation while they're still in completion mode. The page
   *  defensively stamps 'gbp_match' if the webhook hasn't fired
   *  yet, so this is non-null whenever attachState='success' and
   *  the client row was resolvable. */
  attachOnboardingStep: OnboardingStep | null;
  /** True when the buyer just completed the $197 audit-upgrade
   *  Checkout (URL has ?upgrade=audit). The page is on the ORIGINAL
   *  scan session_id at this point, not the audit session — the
   *  webhook handles audit lead_orders creation server-side. We use
   *  this flag to:
   *    1. Surface an "audit upgrade purchased ✓" confirmation banner
   *       above the intake form
   *    2. Skip the AuditUpgradePanel pitch (they already upgraded)
   *    3. Treat upgradeChoice as effectively 'accepted' for layout
   *       decisions */
  isAuditUpgrade: boolean;
  /** Pre-resolved Stripe saved-card metadata from the original scan
   *  purchase. When non-null, the AuditUpgradePanel shows a
   *  no-redirect "Confirm \$197 charge to **** 4242" button that
   *  fires /api/upgrade/audit/confirm (off-session PaymentIntent).
   *  When null, panel falls back to the Stripe Checkout redirect via
   *  /api/upgrade/audit/create-session. */
  savedCard: { brand: string; last4: string } | null;
  /** Warm-cohort prospect_id captured at /yourmap or /freescan
   *  checkout time, sourced from the Stripe session's metadata.
   *  When set + the buyer reaches the post-fulfillment view ("Your
   *  TurfMap is ready"), we POST /api/prospect/[id]/engaged to stamp
   *  prospects.scan_engaged_at — the trigger gate for the Stage 2
   *  audit-upgrade email cron. NULL when the buyer didn't come from
   *  a cohort lander. The endpoint is cohort-scoped, so firing it
   *  for non-warm-cohort prospect_ids is a safe no-op. */
  prospectId: string | null;
  /** Cohort discriminator from session.metadata.cohort. When
   *  'crm_reactivation_q2' (VIP warm cohort), we MUST NOT render the
   *  AuditUpgradePanel or PulseAttachPanel on /order/success — the
   *  campaign brief explicitly suppresses commercial follow-ups at the
   *  gift-delivery moment. Stage 2 email (auto-fired 30 min — 24 hr
   *  after dashboard engagement) is the SOLE entry point to the audit
   *  upgrade for this cohort. */
  cohort: string | null;
  /** Amount in cents the buyer actually paid for the original
   *  TurfScan (Stripe session.amount_total). Belt-and-braces
   *  suppression for the AuditUpgradePanel: any $0 scan (VIP, future
   *  100%-off codes) hides the panel because the $302 UPGRADE_302_CREDIT
   *  has no scan price to "count" toward the $499 audit. NULL when
   *  Stripe didn't surface amount_total — defaults to showing the
   *  panel (existing behavior). */
  amountTotalCents: number | null;
  /** Pre-fill value for the "Keyword to scan" field, sourced from
   *  the cohort prospect's trade (e.g. "hvac", "roofer", "plumber").
   *  When the buyer reached /order/success from a cohort lander, this
   *  pre-fills the intake so their full scan matches the preview-data
   *  narrative. Buyer can still edit if they want a different keyword.
   *  NULL for organic buyers or when the prospect lookup failed. */
  prefillKeyword: string | null;
  /**
   * Intake-first payload — non-null when the buyer arrived through the
   * /scan/intake form (cold-Meta funnel). All five fields are already
   * known + stamped on Stripe metadata; this form auto-submits
   * /api/orders/fulfill on mount and never shows the form UI. The
   * buyer experiences /order/success as "Starting your scan…" → scan
   * success card, no second data-entry step.
   *
   * NULL = legacy Stripe-first flow (/fourdots, /yourmap, /freescan).
   * The form renders normally and waits for buyer input.
   */
  prefilledIntake: {
    businessName: string;
    address: string;
    keyword: string;
    /** Full keywords list — 1 for scan/audit, 3 for strategy.
     *  Optional with fall-through to [keyword] for back-compat with
     *  sessions stamped before strategy-tier support. */
    keywords?: string[];
    email: string;
    phone: string;
    latitude: number | null;
    longitude: number | null;
    components: {
      street_address: string | null;
      city: string | null;
      region: string | null;
      postcode: string | null;
      country_code: string | null;
    } | null;
  } | null;
  /**
   * Score-funnel unlock payload — non-null when the buyer arrived
   * via /score → $99 unlock. When set, the form skips intake +
   * auto-fulfill entirely (the webhook handler did all the work)
   * and renders the post-success card directly with a "View your
   * scan" CTA to /share/<shareId>. clientPublicId powers the
   * portal-link surfaces in the success card.
   */
  scoreUnlock: {
    shareId: string;
    clientId: string;
    scanId: string;
    clientPublicId: string | null;
  } | null;
}) {
  const [businessName, setBusinessName] = useState('');
  const [address, setAddress] = useState('');
  const [keywords, setKeywords] = useState<string[]>(() => {
    // Pre-fill the first keyword slot with the prospect's trade when
    // available (e.g. "hvac", "roofer"). Subsequent slots (Strategy +
    // Pulse+ buyers get 3) stay blank so the buyer fills them with
    // their additional keyword targets.
    const seeded = Array(keywordCount).fill('');
    if (prefillKeyword) seeded[0] = prefillKeyword;
    return seeded;
  });
  const [email, setEmail] = useState(prefillEmail ?? '');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set on successful fulfillment — used to link the buyer straight
   *  to their dashboard. Null on partial-failure or pre-Stripe-wired
   *  scenarios where the email path is still our best fallback. */
  const [publicId, setPublicId] = useState<string | null>(null);
  /** Optional human-readable note from the fulfill API (used for the
   *  "partial scan failure" / "already fulfilled" cases). */
  const [partialMessage, setPartialMessage] = useState<string | null>(null);
  /** Cal.com booking URL — set on Audit + Strategy fulfillments
   *  when CAL_COM_*_URL env is configured. NULL otherwise → success
   *  state falls back to "your strategist will email" copy. */
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);
  /** Onboarding wizard step — set on Pulse / Pulse+ fulfillments.
   *  Null for one-time tiers + agency-managed clients. The wizard
   *  takes over the success state when present. */
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep | null>(
    null
  );
  /** Tracks the buyer's response to the AuditUpgradePanel on scan
   *  tier fulfillments. While 'pending', the success card ("Your
   *  TurfMap is ready" / "Open my TurfMap →") is hidden so it
   *  doesn't compete with the upgrade CTA. Becomes 'skipped' when
   *  the buyer clicks the "Skip — open my TurfMap →" button. The
   *  'accepted' state isn't tracked here because clicking "Add the
   *  Roadmap" redirects to Stripe Checkout — the buyer leaves this
   *  page entirely. */
  const [upgradeChoice, setUpgradeChoice] = useState<'pending' | 'skipped'>(
    'pending'
  );
  /** Set to true when the 1-click inline confirm path succeeds.
   *  Equivalent to the ?upgrade=audit URL flag from the redirect
   *  path — used to show the "audit purchased" banner above the
   *  intake form. Distinct from upgradeChoice='skipped' (which
   *  means the buyer declined the upgrade). */
  const [inlineUpgradeAccepted, setInlineUpgradeAccepted] = useState(false);

  // Pulse-attach return path: when the buyer comes back from Stripe
  // with ?attach=success or ?attach=cancelled, server resolves the
  // existing client public_id and hands it down. We hydrate `done`
  // and `publicId` from that so the success card renders directly —
  // the buyer already filled the form on the original purchase, no
  // need to make them do it again. Runs once on mount.
  //
  // Same hydration applies to score_unlock buyers: the /score
  // → $99 unlock has already had its work done by the webhook
  // handler (client flipped to non-preview, AI Coach generation
  // queued, emails sent). The form should render the success card
  // immediately rather than show an intake form for data the buyer
  // already entered on /score. The "View your scan" CTA in the
  // success card uses scoreUnlock.shareId to deep-link the buyer
  // straight to /share/<id> (which now renders in full mode).
  useEffect(() => {
    if (attachState && attachPublicId) {
      setPublicId(attachPublicId);
      setDone(true);
      return;
    }
    if (scoreUnlock) {
      setPublicId(scoreUnlock.clientPublicId);
      setDone(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Warm-cohort engagement stamp ────────────────────────────────
  // When the post-fulfillment success state renders ("Your TurfMap is
  // ready"), fire POST /api/prospect/[id]/engaged. This stamps
  // prospects.scan_engaged_at — the trigger that gates the Stage 2
  // audit-upgrade email cron (every 15 min, sends 30 min after engagement
  // and within the 24h upgrade window).
  //
  // The endpoint is cohort-scoped to crm_reactivation_q2 server-side, so
  // firing for cold-email cohort prospect_ids is a clean no-op. Idempotent
  // too: subsequent calls return { status: 'noop' } once the column is
  // already set.
  //
  // Gated on `done && publicId && prospectId` so we only fire once the
  // scan has actually fulfilled — not while the form is still loading.
  // Tracked in engagedPosted state to prevent re-fires on re-renders.
  const [engagedPosted, setEngagedPosted] = useState(false);
  useEffect(() => {
    if (engagedPosted) return;
    if (!done || !publicId || !prospectId) return;
    setEngagedPosted(true);
    fetch(`/api/prospect/${encodeURIComponent(prospectId)}/engaged`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }).catch((e) => {
      // Non-fatal: a missed engagement stamp just means the Stage 2
      // cron won't fire for this buyer. The buyer's experience isn't
      // affected. Log for ops visibility.
      console.warn(
        '[order/success] engaged POST failed (non-fatal)',
        e instanceof Error ? e.message : String(e)
      );
    });
  }, [done, publicId, prospectId, engagedPosted]);

  // ─── Intake-first auto-fulfill ───────────────────────────────────
  // When the buyer arrived through /scan/intake (cold-Meta flow),
  // every intake field is already stamped on the Stripe session
  // metadata + threaded down here as `prefilledIntake`. We don't
  // need to re-prompt — fire /api/orders/fulfill once on mount and
  // let the page transition straight to the post-fulfillment
  // success state.
  //
  // One-shot guard via ref so React-strict-mode double-mounts and
  // any state-change-driven re-runs of this effect can't fire two
  // fulfill POSTs. /api/orders/fulfill is server-side idempotent
  // on lead_orders.status anyway, but the local guard avoids the
  // double-spinner UX glitch.
  const intakeAutoFulfillRef = useRef(false);
  useEffect(() => {
    if (!prefilledIntake) return;
    if (!sessionId) return;
    if (intakeAutoFulfillRef.current) return;
    if (done) return;
    // score_unlock buyers have no intake to auto-fulfill (the webhook
    // handler did everything); the hydration effect above already
    // flipped done=true. This guard is belt-and-suspenders so a
    // future refactor that loses the done=true seed doesn't trigger
    // a spurious fulfill POST with empty fields.
    if (scoreUnlock) return;
    intakeAutoFulfillRef.current = true;

    let cancelled = false;
    (async () => {
      setError(null);
      setBusy(true);
      try {
        const res = await fetch('/api/orders/fulfill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tier,
            sessionId,
            businessName: prefilledIntake.businessName,
            address: prefilledIntake.address,
            // Use the full keywords[] array from intake (1 for
            // scan/audit, 3 for strategy). Falls back to a single-
            // element array for legacy intake-first sessions stamped
            // before strategy-tier support.
            keywords:
              prefilledIntake.keywords && prefilledIntake.keywords.length > 0
                ? prefilledIntake.keywords
                : [prefilledIntake.keyword],
            email: prefilledIntake.email,
            phone: prefilledIntake.phone,
            // Mapbox-picked geo (when present) so fulfill skips
            // Nominatim and uses the exact coordinates instead.
            // Prevents wrong-city matches for ambiguously-named
            // streets (Hendricks / Meadowview class of bug).
            latitude: prefilledIntake.latitude ?? undefined,
            longitude: prefilledIntake.longitude ?? undefined,
            components: prefilledIntake.components ?? undefined,
          }),
        });
        if (cancelled) return;
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          public_id?: string;
          already_fulfilled?: boolean;
          message?: string;
          booking_url?: string | null;
          onboarding_step?: OnboardingStep | null;
        };
        // 409 (already_fulfilled) — treat as success, same as the
        // hand-submit path. Happens when the webhook beat us to it.
        if (res.status === 409 && data.already_fulfilled) {
          setPublicId(
            typeof data.public_id === 'string' ? data.public_id : null
          );
          setBookingUrl(
            typeof data.booking_url === 'string' ? data.booking_url : null
          );
          setOnboardingStep(
            (data.onboarding_step as OnboardingStep | null) ?? null
          );
          setDone(true);
          setBusy(false);
          return;
        }
        if (!res.ok) {
          setError(
            data.error ??
              "We couldn't fire your scan. Email support@turfmap.ai with your order id and we'll fulfill manually."
          );
          setBusy(false);
          return;
        }
        setPublicId(
          typeof data.public_id === 'string' ? data.public_id : null
        );
        setPartialMessage(
          typeof data.message === 'string' ? data.message : null
        );
        setBookingUrl(
          typeof data.booking_url === 'string' ? data.booking_url : null
        );
        setOnboardingStep(
          (data.onboarding_step as OnboardingStep | null) ?? null
        );
        setDone(true);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [prefilledIntake, sessionId, tier, done]);

  const setKeywordAt = (idx: number, value: string) => {
    setKeywords((prev) => {
      const next = [...prev];
      next[idx] = value;
      return next;
    });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Cheap client-side sanity checks. Server will re-validate.
    if (!businessName.trim()) return setError('Business name is required.');
    if (!address.trim()) return setError('Service address is required.');
    if (!email.trim()) return setError('Email is required.');
    if (!phone.trim())
      return setError(
        'Business phone is required for the citation check.'
      );
    if (keywords.some((k) => !k.trim())) {
      return setError(
        keywordCount === 1
          ? 'Keyword is required.'
          : `All ${keywordCount} keywords are required.`
      );
    }
    if (!sessionId) {
      return setError(
        'Order session id is missing — checkout link looks malformed. Email support@turfmap.ai and we will fire your scan manually.'
      );
    }

    setBusy(true);
    try {
      const res = await fetch('/api/orders/fulfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier,
          sessionId,
          businessName: businessName.trim(),
          address: address.trim(),
          keywords: keywords.map((k) => k.trim()),
          email: email.trim(),
          phone: phone.trim() || null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        ok?: boolean;
        public_id?: string;
        primary_scan_id?: string | null;
        already_fulfilled?: boolean;
        partial?: boolean;
        message?: string;
        booking_url?: string | null;
        onboarding_step?: OnboardingStep | null;
      };

      // 409 = already fulfilled. Treat as success — show the
      // fulfilled state with whatever client_id we got back.
      // Resume the wizard if onboarding_step was returned (Pulse / Pulse+
      // who closed the tab and came back, or a refresh mid-flow).
      if (res.status === 409 && data.already_fulfilled) {
        setPublicId(typeof data.public_id === 'string' ? data.public_id : null);
        setBookingUrl(
          typeof data.booking_url === 'string' ? data.booking_url : null
        );
        setOnboardingStep(
          (data.onboarding_step as OnboardingStep | null) ?? null
        );
        setDone(true);
        setBusy(false);
        return;
      }

      // 404 still possible in the unlikely case the migration hasn't
      // landed yet (e.g. local dev pre-0008-apply). Helpful fallback
      // copy that points the buyer at email-based recovery.
      if (res.status === 404) {
        setError(
          "Order intake isn't fully wired yet. We saw your payment — email support@turfmap.ai with these details and we'll fire your scan manually."
        );
        setBusy(false);
        return;
      }

      if (!res.ok) {
        setError(data.error ?? `submit failed (HTTP ${res.status})`);
        setBusy(false);
        return;
      }

      // Capture public_id so the success state can link the buyer
      // straight to their scan dashboard. Falls back to the email-
      // delivery message when not present.
      setPublicId(typeof data.public_id === 'string' ? data.public_id : null);
      setPartialMessage(typeof data.message === 'string' ? data.message : null);
      setBookingUrl(
        typeof data.booking_url === 'string' ? data.booking_url : null
      );
      setOnboardingStep(
        (data.onboarding_step as OnboardingStep | null) ?? null
      );
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (done) {
    // Self-serve subscription buyers (Pulse / Pulse+) hand off to the
    // multi-step wizard, which manages its own UX (GBP confirmation,
    // team invites, competitors, then the "TurfMap is ready" CTA).
    // Pulse+ + Pulse only — one-time tiers fall through to the
    // existing simple success card below.
    if (onboardingStep && publicId && sessionId) {
      return (
        <OnboardingWizard
          publicId={publicId}
          sessionId={sessionId}
          initialStep={onboardingStep}
        />
      );
    }
    // Pulse-attach panel surfaces only on one-time tiers, only when
    // the buyer hasn't already opted in or cancelled mid-flow, and
    // only when we have the data needed to bind the trial to the
    // existing Stripe customer + client row.
    //
    // WARM-COHORT SUPPRESSION: per campaign brief, the Pulse-attach
    // panel MUST NOT render for crm_reactivation_q2 buyers on
    // /order/success. They received the scan as a gift; surfacing a
    // commercial subscription pitch at the gift-delivery moment
    // damages the warm relationship. Only Stage 2 email (auto-fired
    // 30 min — 24 hr post-engagement) carries any pitch for this
    // cohort.
    const isWarmCohort = cohort === 'crm_reactivation_q2';
    const isOneTimeTier =
      tier === 'scan' || tier === 'audit' || tier === 'strategy';
    const showAttachPanel =
      isOneTimeTier &&
      attachState !== 'success' &&
      publicId &&
      sessionId &&
      stripeCustomerId &&
      !isWarmCohort;

    // Compact celebration vs full success card. When the attach panel
    // is the focal point of the page (most one-time-tier success
    // hits), the original "Your TurfMap is ready" + big lime CTA card
    // would compete with the attach for the buyer's attention. Render
    // it as a compact acknowledgment row instead — the buyer's
    // dashboard exit lives inside the attach panel as a "Skip" link.
    //
    // When the attach panel is hidden (Pulse already attached, the
    // tier is itself a Pulse purchase, or attach=success), the
    // original full success card is the right hero — restore it.
    // Pulse-attach onboarding-wizard handoff. When the buyer is back
    // from a successful trial activation AND we have everything the
    // wizard needs (publicId, sessionId, onboarding_step), render the
    // wizard inline. This is "Option B" from the launch review: drop
    // the buyer straight into GBP confirmation + setup while they're
    // still in completion mode, instead of showing a static banner
    // they have to click out of and re-enter from a portal alert.
    //
    // The wizard expects ?session_id to authorize against the original
    // lead_orders row — the buyer's one-time purchase session is still
    // valid for that. requireOnboardingSession (lib/auth/onboarding.ts)
    // joins lead_orders.stripe_session_id → client_id and confirms
    // status='fulfilled'.
    const showAttachWizard =
      attachState === 'success' &&
      attachPublicId &&
      attachOnboardingStep &&
      sessionId &&
      attachOnboardingStep !== 'done';

    // When the wizard takes over, return early — no success card, no
    // attach panel, no Cal.com booking. The wizard's "done" step has
    // its own "Open my TurfMap" CTA, and the buyer already engaged
    // with the original Cal.com booking on the first pass through
    // /order/success (audit/strategy tiers don't see the attach
    // panel anyway because the trial-attach is a Pulse offer; if a
    // future product change lets audit/strategy buyers also attach,
    // we'd need to surface the booking inside or after the wizard).
    if (showAttachWizard && attachPublicId && sessionId && attachOnboardingStep) {
      return (
        <>
          <div
            className="relative rounded-lg p-4 mb-5 flex items-center gap-3 animate-scale-in animate-lime-glow"
            style={{
              background: 'var(--color-card-glow)',
              border: '1px solid var(--color-border-bright)',
            }}
          >
            <SuccessBurst active variant="compact" />
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
              style={{
                background: 'var(--color-lime)',
                boxShadow: '0 0 14px #c5ff3a40',
              }}
            >
              <Sparkles size={15} className="text-black" strokeWidth={2.75} />
            </div>
            <div className="flex-1 min-w-0 relative">
              <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
                Pulse trial active · 30 days free
              </div>
              <p className="text-sm text-zinc-300 leading-snug mt-0.5">
                One last step: confirm your business details so weekly
                scans + the AI Coach get the right inputs.
              </p>
            </div>
          </div>
          <OnboardingWizard
            publicId={attachPublicId}
            sessionId={sessionId}
            initialStep={attachOnboardingStep}
          />
        </>
      );
    }

    return (
      <>
        {/* Static attach-success banner — fallback when the wizard
         *  can't mount (missing publicId/sessionId/step or wizard
         *  already completed). Original celebratory copy + the
         *  day-31 framing. */}
        {attachState === 'success' && (
          <div
            className="relative border rounded-lg p-5 mb-5 flex items-start gap-3 animate-scale-in animate-lime-glow"
            style={{
              background: 'var(--color-card-glow)',
              borderColor: 'var(--color-border-bright)',
            }}
          >
            <SuccessBurst active variant="compact" />
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
              style={{
                background: 'var(--color-lime)',
                boxShadow: '0 0 18px #c5ff3a40',
              }}
            >
              <Sparkles size={16} className="text-black" strokeWidth={2.75} />
            </div>
            <div className="flex-1 relative">
              <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-1">
                Pulse trial active
              </div>
              <div className="font-display text-lg font-bold leading-tight mb-1">
                Free for 30 days. Cancel anytime before then.
              </div>
              <p className="text-sm text-zinc-400 leading-relaxed">
                Your map will auto-rescan every Monday. We&rsquo;ll email
                when your TurfScore moves more than ±5. First charge:{' '}
                <span className="font-mono text-zinc-200">$39</span> on
                day 31 — manage or cancel anytime from your portal.
              </p>
            </div>
          </div>
        )}

        {/* Attach cancelled banner — shown when the buyer hit Cancel
         *  on Stripe's hosted page. Light reassurance + no nag, plus
         *  the attach panel still mounts below so they can retry if
         *  they changed their mind. */}
        {attachState === 'cancelled' && (
          <div
            className="border rounded-md px-4 py-3 mb-5 flex items-start gap-2.5 text-xs"
            style={{
              background: 'var(--color-card)',
              borderColor: 'var(--color-border)',
              color: '#a1a1aa',
            }}
          >
            <Check size={14} className="flex-shrink-0 mt-0.5" />
            <span className="leading-relaxed">
              No problem — your TurfScan is still on its way. The Pulse
              trial offer is below if you change your mind.
            </span>
          </div>
        )}

        {/* Post-fulfillment state. The audit-upgrade decision has
         *  already been made BEFORE this point (pre-intake gate
         *  renders the AuditUpgradePanel earlier), so we don't
         *  need to surface it again here. Pulse-attach is the next
         *  conversion opportunity in the funnel. */}
        <>
        {showAttachPanel ? (
          // Attach-panel-primary layout. Compact celebration header,
          // then the attach panel as the hero element, then any
          // tier-specific extras (Cal.com booking for audit/strategy).
          <>
            <div
              className="border rounded-lg p-5 mb-5 flex items-center gap-3"
              style={{
                background: 'var(--color-card)',
                borderColor: 'var(--color-border)',
              }}
            >
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                style={{
                  background: 'var(--color-lime)',
                  boxShadow: '0 0 12px #c5ff3a30',
                }}
              >
                <Check size={16} className="text-black" strokeWidth={3} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-display text-base md:text-lg font-bold leading-tight">
                  {publicId
                    ? 'Your TurfMap is ready.'
                    : 'Running your scan…'}
                </div>
                <p className="text-xs text-zinc-500 leading-relaxed mt-0.5 truncate">
                  Link sent to{' '}
                  <span className="font-mono text-zinc-300">{email}</span>.
                </p>
              </div>
            </div>

            <PulseAttachPanel
              publicId={publicId}
              stripeCustomerId={stripeCustomerId}
              originalSessionId={sessionId}
            />

            {(tier === 'audit' || tier === 'strategy') && bookingUrl && (
              <div className="mt-6">
                <CalEmbed
                  bookingUrl={bookingUrl}
                  email={email}
                  businessName={businessName}
                  notes={`Booking from TurfMap ${tier === 'strategy' ? 'Strategy Session' : 'Visibility Audit'} order for ${businessName}.`}
                  tierLabel={
                    tier === 'strategy'
                      ? '90-min Strategy Session'
                      : '30-min Audit walkthrough'
                  }
                />
              </div>
            )}
            {(tier === 'audit' || tier === 'strategy') && !bookingUrl && (
              <p className="text-sm text-zinc-500 leading-relaxed mt-6">
                Your strategist will email separately within 2 business days
                with the diagnosis
                {tier === 'strategy' &&
                  ' and a calendar link to book your call'}
                .
              </p>
            )}
          </>
        ) : (
          // Full success-card layout. Renders when the attach panel
          // shouldn't show (Pulse already attached, attach=success,
          // tier is itself Pulse/Pulse+). The big "Open my TurfMap"
          // CTA is the focal point because there's nothing else
          // competing for attention here.
          //
          // The card scales in on mount + (when we've actually got a
          // publicId, meaning the scan completed) fires a lime
          // sparkle burst from center. Both animations no-op for
          // users with prefers-reduced-motion.
          <div
            className="relative border rounded-lg p-8 text-center animate-scale-in overflow-visible"
            style={{
              background: 'var(--color-card)',
              borderColor: 'var(--color-border-bright)',
            }}
          >
            {/* Sparkle burst — only fires when the scan landed
             *  (publicId set). The "Running your scan…" state
             *  shouldn't celebrate anything yet. */}
            <SuccessBurst active={Boolean(publicId)} />
            <div className="font-display text-2xl font-bold mb-3 relative">
              {publicId ? 'Your TurfMap is ready.' : 'Running your scan…'}
            </div>
            <p className="text-zinc-300 leading-relaxed max-w-xl mx-auto mb-6">
              {partialMessage ?? (
                <>
                  We&rsquo;ve sent the link to{' '}
                  <span className="font-mono text-zinc-100">{email}</span>.
                  You can also bookmark this page or click below to open
                  your dashboard now.
                </>
              )}
            </p>
            {/* Score-unlock buyers get the share-page CTA as primary —
             *  the share IS the artifact they just paid to unlock,
             *  and it carries the same heatmap + AI Coach (once
             *  generation finishes) as the portal would. Portal access
             *  exists for them too via ensurePortalUser, but the
             *  immediate "I want to see my map" intent lands on the
             *  share. Buyers without scoreUnlock fall back to the
             *  existing portal CTA. */}
            {scoreUnlock ? (
              <a
                href={`/share/${scoreUnlock.shareId}`}
                className="inline-flex items-center gap-2 rounded-md font-bold text-sm py-3 px-5 transition-all whitespace-nowrap hover:brightness-110"
                style={{
                  background: 'var(--color-lime)',
                  color: 'black',
                  boxShadow: '0 6px 20px #c5ff3a40',
                }}
              >
                View my full TurfMap →
              </a>
            ) : (
              publicId && (
                <a
                  href={`/portal/${publicId}`}
                  className="inline-flex items-center gap-2 rounded-md font-bold text-sm py-3 px-5 transition-all whitespace-nowrap hover:brightness-110"
                  style={{
                    background: 'var(--color-lime)',
                    color: 'black',
                    boxShadow: '0 6px 20px #c5ff3a40',
                  }}
                >
                  Open my TurfMap →
                </a>
              )
            )}
            {(tier === 'audit' || tier === 'strategy') && bookingUrl && (
              <CalEmbed
                bookingUrl={bookingUrl}
                email={email}
                businessName={businessName}
                notes={`Booking from TurfMap ${tier === 'strategy' ? 'Strategy Session' : 'Visibility Audit'} order for ${businessName}.`}
                tierLabel={
                  tier === 'strategy'
                    ? '90-min Strategy Session'
                    : '30-min Audit walkthrough'
                }
              />
            )}
            {(tier === 'audit' || tier === 'strategy') && !bookingUrl && (
              <p className="text-sm text-zinc-500 leading-relaxed max-w-xl mx-auto mt-6">
                Your strategist will email separately within 2 business days
                with the diagnosis
                {tier === 'strategy' &&
                  ' and a calendar link to book your call'}
                .
              </p>
            )}
          </div>
        )}

        {/* Score-unlock-only audit upsell. Standalone TurfScan buyers
         *  see the AuditUpgradePanel via the pre-intake gate (below,
         *  ~L897). Score_unlock buyers bypass that gate because the
         *  mount-time useEffect hydrates done=true from the scoreUnlock
         *  prop to skip the intake form they already filled on
         *  /prove-it. Without this inline panel they'd never see the
         *  audit upsell at all — losing the highest-intent moment of
         *  the session. Placed BELOW the success card so the "View
         *  my full TurfMap" CTA reads first (immediate intent honored),
         *  then the upsell pitches once they've registered the win.
         *  See CertaPro Calgary / Justin Enns incident 2026-06-04. */}
        {scoreUnlock &&
          sessionId &&
          upgradeChoice === 'pending' &&
          !isAuditUpgrade &&
          !inlineUpgradeAccepted && (
            <div className="mt-6">
              <AuditUpgradePanel
                source="order_success"
                sessionId={sessionId}
                savedCard={savedCard}
                onSkip={() => setUpgradeChoice('skipped')}
                onInlineConfirmSuccess={() => {
                  setInlineUpgradeAccepted(true);
                  void import('@/components/marketing/scan/MetaPixel').then(
                    ({ trackMetaEvent }) => {
                      trackMetaEvent('Purchase', {
                        currency: 'USD',
                        value: 197,
                        content_name: 'Visibility Audit',
                        content_category: 'upgrade',
                      });
                    }
                  );
                }}
              />
            </div>
          )}
        </>
      </>
    );
  }

  // ─── Intake-first auto-fulfill loader ─────────────────────────────
  // When the buyer arrived through /scan/intake (cold-Meta flow), the
  // useEffect above is mid-flight POSTing /api/orders/fulfill with
  // the prefilled intake data. Render a "Starting your scan…" loader
  // instead of the form (which would just collect data we already
  // have) or the AuditUpgradePanel (which the post-fulfillment branch
  // below handles after done=true). Error state still renders so the
  // buyer has a recovery message if fulfill fails.
  if (prefilledIntake && !done) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-6">
        <ScanProgress className="max-w-md w-full" />
        {error && (
          <p
            className="text-xs leading-relaxed flex items-start gap-1.5 max-w-md"
            style={{ color: '#f5b651' }}
            role="alert"
          >
            <span className="font-mono">⚠</span>
            <span>{error}</span>
          </p>
        )}
      </div>
    );
  }

  // ─── Pre-intake audit-upgrade gate ────────────────────────────────
  // When the buyer just paid for a scan tier and hasn't yet decided
  // on the audit upgrade, show the AuditUpgradePanel ALONE — the
  // intake form is hidden until they click Skip or come back from a
  // successful upgrade Checkout. This forces the upsell decision
  // BEFORE intake friction, which is where conversion intent is
  // highest. isAuditUpgrade=true means they came back from a
  // successful upgrade Checkout; skip the pitch and go straight to
  // intake (with a confirmation banner).
  //
  // WARM-COHORT SUPPRESSION: crm_reactivation_q2 buyers MUST NOT
  // see the AuditUpgradePanel anywhere on /order/success per campaign
  // brief. Stage 2 email is the only entry point to the audit upgrade
  // for this cohort. cohort === 'crm_reactivation_q2' short-circuits
  // straight to the intake form path below.
  const isWarmCohortForUpgradeGate = cohort === 'crm_reactivation_q2';
  // Free-scan suppression — belt-and-braces with the API's step-1.5
  // free-scan gate. If the original scan was $0 (VIP, future 100%-off
  // codes), the $302 UPGRADE_302_CREDIT has no scan price to count
  // toward the audit, so we don't pitch the upgrade. Stripe didn't
  // resolve amount_total (=== null) → fall through to existing
  // behavior, since we can't prove the scan was free.
  const isFreeScanForUpgradeGate = amountTotalCents === 0;
  if (
    !done &&
    tier === 'scan' &&
    sessionId &&
    upgradeChoice === 'pending' &&
    !isAuditUpgrade &&
    !inlineUpgradeAccepted &&
    !isWarmCohortForUpgradeGate &&
    !isFreeScanForUpgradeGate
  ) {
    return (
      <AuditUpgradePanel
        source="order_success"
        sessionId={sessionId}
        savedCard={savedCard}
        onSkip={() => setUpgradeChoice('skipped')}
        onInlineConfirmSuccess={() => {
          // 1-click confirm succeeded server-side. Flip choice so
          // the next render bypasses the panel and renders the
          // intake form with an "audit purchased" banner (same
          // visual state as the Stripe-Checkout-redirect return
          // path with ?upgrade=audit).
          setInlineUpgradeAccepted(true);
          // Fire Meta Pixel Purchase for the inline 1-click upgrade.
          // The Stripe-Checkout-redirect path fires Purchase server-
          // rendered on /order/success when ?upgrade=audit lands; this
          // off-session path never redirects, so we fire from the
          // client when the confirm succeeds. Same payload either way
          // so events are interchangeable in Meta Events Manager.
          void import('@/components/marketing/scan/MetaPixel').then(
            ({ trackMetaEvent }) => {
              trackMetaEvent('Purchase', {
                currency: 'USD',
                value: 197,
                content_name: 'Visibility Audit',
                content_category: 'upgrade',
              });
            }
          );
        }}
      />
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="border rounded-lg p-6 md:p-8 space-y-5"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      {/* Audit-upgrade-purchased confirmation banner. Renders only
       *  when the buyer returned from a successful $197 upgrade
       *  Checkout (URL has ?upgrade=audit). The webhook has already
       *  created the audit lead_orders row in pending state; when
       *  the buyer submits this intake form, /api/orders/fulfill
       *  sweeps that row, links client_id + scan_id, creates the
       *  visibility_audits row, and stamps prospects.upgraded_to_audit_at. */}
      {(isAuditUpgrade || inlineUpgradeAccepted) && (
        <div
          className="border rounded-md px-4 py-3 -mt-2 mb-1 flex items-start gap-2.5"
          style={{
            background: 'var(--color-card-glow)',
            borderColor: 'var(--color-border-bright)',
          }}
        >
          <Check
            size={16}
            strokeWidth={2.75}
            className="flex-shrink-0 mt-0.5"
            style={{ color: 'var(--color-lime)' }}
          />
          <div className="leading-relaxed text-sm">
            <div className="font-semibold text-zinc-100 mb-0.5">
              Visibility Audit upgrade purchased — $197
            </div>
            <div className="text-xs text-zinc-400">
              Your audit will be queued the moment you submit your
              business details below. Strategist call link goes out
              after.
            </div>
          </div>
        </div>
      )}
      <Field label="Business name" required>
        <input
          type="text"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          placeholder="e.g. Smith & Sons Plumbing"
          required
          className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-base sm:text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
        />
      </Field>

      <Field
        label="Service address"
        required
        hint="Start typing your address — pick from the dropdown so we can center the 81-cell grid precisely on your storefront."
      >
        <AddressAutocomplete
          value={address}
          onChange={setAddress}
          onSelect={(fields: AddressFields) => {
            // Buyer picked a Mapbox suggestion — the input now holds
            // the canonical full_address. The server-side fulfill
            // still re-geocodes via Nominatim for cross-validation,
            // but a Mapbox-resolved address effectively guarantees a
            // clean Nominatim hit.
            setAddress(fields.formatted);
          }}
          placeholder="123 Main St, Toronto"
          required
        />
      </Field>

      {keywordCount === 1 ? (
        <Field
          label="Keyword to scan"
          required
          hint='Pick the most-searched term someone would type to find a business like yours, e.g. "plumber toronto".'
        >
          <input
            type="text"
            value={keywords[0]}
            onChange={(e) => setKeywordAt(0, e.target.value)}
            placeholder="plumber toronto"
            required
            className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-base sm:text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
          />
        </Field>
      ) : (
        <Field
          label="Three keywords to scan"
          required
          hint="Strategy Session scans three keywords across the same grid so you can compare. Pick the strongest variant first."
        >
          <div className="space-y-2">
            {keywords.map((k, i) => (
              <input
                key={i}
                type="text"
                value={k}
                onChange={(e) => setKeywordAt(i, e.target.value)}
                placeholder={
                  i === 0
                    ? 'plumber toronto'
                    : i === 1
                      ? 'emergency plumber toronto'
                      : 'plumbing services toronto'
                }
                required
                className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-base sm:text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
              />
            ))}
          </div>
        </Field>
      )}

      {/* Email + business phone — both required across every tier.
       *  The phone is the P in NAP (Name / Address / Phone), the
       *  citation triplet that BrightLocal cross-references against
       *  ~25 directories to surface inconsistencies. Without it,
       *  locationToBusinessProfile() returns null and maybeRunNapAudit
       *  short-circuits, so the buyer pays for the "Citation check
       *  across the directories that matter for your trade" deliverable
       *  but the audit never actually runs.
       *
       *  Pre-fix the phone was only collected for Audit/Strategy
       *  tiers under a "for the strategist call" hint that was both
       *  wrong (Cal.com event types collect their own phone during
       *  booking) and missing (TurfScan and Pulse/Pulse+ skipped
       *  collection entirely). Required-on-every-tier closes the
       *  citation-check gap. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Email" required>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@business.com"
            required
            className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-base sm:text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
          />
        </Field>
        <Field
          label="Business phone"
          required
          hint="Used to cross-reference your business listing across Google, Yelp, Bing, Apple Maps, and ~25 other directories — required for the citation check."
        >
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(416) 555-0100"
            required
            className="w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-base sm:text-sm font-mono text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
          />
        </Field>
      </div>

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md font-bold text-sm py-3 px-4 flex items-center justify-center gap-2 transition-all whitespace-nowrap hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
        style={{
          background: 'var(--color-lime)',
          color: 'black',
          boxShadow: '0 6px 20px #c5ff3a40',
        }}
      >
        {busy ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            Firing your scan…
          </>
        ) : (
          <>
            Fire my TurfMap scan
            <ArrowRight size={14} strokeWidth={2.5} />
          </>
        )}
      </button>

      {error && (
        <div
          className="text-sm rounded-md p-3 leading-relaxed"
          style={{
            background: '#1a0606',
            border: '1px solid #3f0a0a',
            color: '#f87171',
          }}
        >
          {error}
        </div>
      )}
      {/* Full-screen progress overlay during the post-submit scan +
       *  fulfillment wait. The button-only "Firing your scan…"
       *  spinner is too quiet for the 30-90s grid scan + 5-9s NAP
       *  audit + 10-20s email-render time the buyer is staring at
       *  immediately after paying. Overlay reassures them the
       *  pipeline is moving through each stage. Backdrop blocks
       *  back-button / refresh during the fulfillment transaction
       *  (a refresh mid-fulfill would lose the success URL params). */}
      {busy && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(10, 10, 10, 0.92)', backdropFilter: 'blur(4px)' }}
          aria-modal="true"
          role="dialog"
        >
          <ScanProgress className="max-w-md" />
        </div>
      )}
    </form>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
          {label}
          {required && (
            <span className="ml-1" style={{ color: 'var(--color-lime)' }}>
              *
            </span>
          )}
        </span>
      </div>
      {children}
      {hint && (
        <p className="text-[11px] text-zinc-600 mt-1.5 leading-snug">{hint}</p>
      )}
    </label>
  );
}
