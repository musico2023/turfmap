'use client';

/**
 * Post-checkout onboarding wizard for self-serve subscription buyers.
 *
 * Renders inside `/order/success` after the intake form submits. The
 * wizard's state lives on `clients.onboarding_step` server-side so a
 * buyer who closes the tab can come back via the same `?session_id=`
 * URL and resume.
 *
 * Steps:
 *   1. GBP confirmation — auto-matched listing + confirm/reject/search/select
 *   2. Portal users    — invite teammates (skippable)
 *   3. Competitors     — Pulse+ only, add up to 3 (skippable)
 *   4. Done            — first scan running + portal CTA
 *
 * All mutations go to /api/onboarding/[publicId] with the buyer's
 * Stripe session_id as proof-of-ownership (lib/auth/onboarding.ts).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, Loader2, Search } from 'lucide-react';

type Status = 'auto' | 'confirmed' | 'manual' | 'rejected' | 'no_match' | null;
type Step = 'gbp_match' | 'portal_users' | 'competitors' | 'done';

type SignalsRow = {
  rating: number | null;
  user_ratings_total: number | null;
  primary_type: string | null;
  business_status: string | null;
  photos_count: number | null;
};

type WizardState = {
  step: Step | null;
  publicId: string;
  tier: 'pulse' | 'pulse_plus' | null;
  locationId: string | null;
  gbp: {
    placeId: string | null;
    status: Status;
    signals: SignalsRow | null;
  };
  portalUserCount: number;
  competitorCount: number;
};

type Candidate = {
  placeId: string;
  displayName: string | null;
  formattedAddress: string | null;
  primaryType: string | null;
  rating: number | null;
  userRatingCount: number | null;
};

const POLL_GBP_MS = 2000;
const POLL_GBP_MAX = 12; // up to ~24s

export function OnboardingWizard({
  publicId,
  sessionId,
  initialStep,
}: {
  publicId: string;
  sessionId: string;
  initialStep: Step;
}) {
  const [state, setState] = useState<WizardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const baseUrl = `/api/onboarding/${publicId}`;

  const refresh = async () => {
    try {
      const res = await fetch(
        `${baseUrl}?sessionId=${encodeURIComponent(sessionId)}`
      );
      const data = (await res.json()) as WizardState | { error: string };
      if (res.ok) setState(data as WizardState);
      else setError(('error' in data && data.error) || 'load failed');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Initial fetch + GBP poll. The Places enrichment runs in `after()`
  // post-fulfill, so the signals row may not exist yet on first mount.
  // Poll for up to ~24s while step=gbp_match and signals are absent.
  useEffect(() => {
    let cancelled = false;
    let polls = 0;
    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(
          `${baseUrl}?sessionId=${encodeURIComponent(sessionId)}`
        );
        const data = (await res.json()) as WizardState | { error: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(('error' in data && data.error) || 'load failed');
          return;
        }
        const next = data as WizardState;
        setState(next);
        const stillWaitingForGbp =
          next.step === 'gbp_match' &&
          next.gbp.signals === null &&
          next.gbp.status === null;
        if (stillWaitingForGbp && polls < POLL_GBP_MAX) {
          polls += 1;
          setTimeout(tick, POLL_GBP_MS);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const post = async (body: Record<string, unknown>): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, sessionId }),
      });
      const data = (await res.json()) as WizardState | { error: string };
      if (!res.ok) {
        setError(('error' in data && data.error) || 'request failed');
        return false;
      }
      // Endpoint returns either the full WizardState or an action-specific
      // payload — only update state when it looks like the full shape.
      if ('step' in (data as object)) {
        setState(data as WizardState);
      } else {
        // Action-specific response (e.g. invite_user). Refresh to sync.
        await refresh();
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const advance = (next: Step) => post({ action: 'advance', step: next });

  if (!state) {
    return (
      <div className="mt-8 mx-auto max-w-2xl rounded-lg border p-8 text-center" style={{ borderColor: 'var(--color-border)', background: 'var(--color-card)' }}>
        <Loader2 className="mx-auto mb-3 animate-spin text-zinc-500" size={20} />
        <p className="text-sm text-zinc-400">Loading your TurfMap setup…</p>
        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  const step: Step = (state.step as Step | null) ?? initialStep;

  return (
    <div className="mt-8 mx-auto max-w-2xl">
      <StepIndicator step={step} tier={state.tier} />
      {step === 'gbp_match' && (
        <GbpStep
          state={state}
          baseUrl={baseUrl}
          sessionId={sessionId}
          post={post}
          advance={advance}
        />
      )}
      {step === 'portal_users' && (
        <PortalUsersStep
          state={state}
          post={post}
          advance={advance}
        />
      )}
      {step === 'competitors' && (
        <CompetitorsStep state={state} post={post} advance={advance} />
      )}
      {step === 'done' && <DoneStep state={state} />}
      {error && (
        <div className="mt-3 text-xs text-red-400 text-center">{error}</div>
      )}
    </div>
  );
}

// ─── Step indicator ────────────────────────────────────────────────────

function StepIndicator({
  step,
  tier,
}: {
  step: Step;
  tier: 'pulse' | 'pulse_plus' | null;
}) {
  const steps: Array<{ id: Step; label: string }> = [
    { id: 'gbp_match', label: 'Confirm GBP' },
    { id: 'portal_users', label: 'Invite team' },
    ...(tier === 'pulse_plus'
      ? [{ id: 'competitors' as Step, label: 'Competitors' }]
      : []),
    { id: 'done', label: 'Done' },
  ];
  const currentIdx = steps.findIndex((s) => s.id === step);
  return (
    <div className="flex items-center gap-2 mb-6 justify-center text-[11px]">
      {steps.map((s, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        return (
          <div key={s.id} className="flex items-center gap-2">
            <div
              className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
              style={{
                background: done || active ? 'var(--color-lime, #c5ff3a)' : '#27272a',
                color: done || active ? 'black' : '#71717a',
              }}
            >
              {done ? <Check size={10} /> : i + 1}
            </div>
            <span style={{ color: active ? '#e4e4e7' : '#71717a' }}>{s.label}</span>
            {i < steps.length - 1 && <span className="text-zinc-700">·</span>}
          </div>
        );
      })}
    </div>
  );
}

// ─── Step 1: GBP match ─────────────────────────────────────────────────

function GbpStep({
  state,
  post,
  advance,
}: {
  state: WizardState;
  baseUrl: string;
  sessionId: string;
  post: (body: Record<string, unknown>) => Promise<boolean>;
  advance: (s: Step) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState<null | 'confirm' | 'reject' | 'search' | 'select' | 'skip'>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const sig = state.gbp.signals;
  const status = state.gbp.status;

  const onSearch = async () => {
    if (!searchQuery.trim()) return;
    setBusy('search');
    try {
      const res = await fetch(`/api/onboarding/${state.publicId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'gbp_search',
          query: searchQuery.trim(),
          sessionId: new URLSearchParams(window.location.search).get('session_id') ?? '',
        }),
      });
      const data = (await res.json()) as
        | { candidates: Candidate[] }
        | { error: string };
      if (res.ok && 'candidates' in data) setCandidates(data.candidates);
    } finally {
      setBusy(null);
    }
  };

  const onSelect = async (placeId: string) => {
    setBusy('select');
    await post({ action: 'gbp_select', placeId });
    setBusy(null);
  };

  const ratingLine =
    sig && (sig.rating !== null || sig.user_ratings_total !== null)
      ? `${sig.rating !== null ? `${sig.rating.toFixed(1)} ★` : ''}${sig.rating !== null && sig.user_ratings_total !== null ? ' · ' : ''}${sig.user_ratings_total !== null ? `${sig.user_ratings_total} reviews` : ''}`
      : null;

  return (
    <Card>
      <h2 className="font-display text-xl font-bold mb-1">Confirm your Google listing</h2>
      <p className="text-xs text-zinc-500 mb-4">
        We auto-matched your business to a Google Business Profile. Take 5 seconds
        to confirm — wrong-business signals would steer your AI Coach playbook in
        the wrong direction.
      </p>

      {!sig && status !== 'rejected' && status !== 'no_match' && (
        <div className="text-center py-6">
          <Loader2 className="mx-auto mb-3 animate-spin text-zinc-500" size={18} />
          <p className="text-xs text-zinc-500">
            Looking up your Google listing…
          </p>
        </div>
      )}

      {sig && (status === 'auto' || status === 'confirmed' || status === 'manual') && (
        <div className="space-y-3">
          <div
            className="rounded-md border p-3 text-sm"
            style={{
              borderColor: 'var(--color-border)',
              background: 'rgba(255,255,255,0.02)',
            }}
          >
            {sig.primary_type && (
              <div className="text-zinc-200 mb-1">{sig.primary_type}</div>
            )}
            {ratingLine && <div className="text-zinc-400 text-xs">{ratingLine}</div>}
            {sig.photos_count !== null && (
              <div className="text-zinc-500 text-xs">{sig.photos_count} photos on listing</div>
            )}
            {sig.business_status && sig.business_status !== 'OPERATIONAL' && (
              <div className="text-amber-400 text-xs mt-1">
                Status: {sig.business_status}
              </div>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            <PrimaryButton
              loading={busy === 'confirm'}
              onClick={async () => {
                setBusy('confirm');
                await post({ action: 'gbp_confirm' });
                setBusy(null);
              }}
            >
              That&apos;s us — continue
            </PrimaryButton>
            <GhostButton
              loading={busy === 'reject'}
              onClick={async () => {
                setBusy('reject');
                await post({ action: 'gbp_reject' });
                setSearchOpen(true);
                setBusy(null);
              }}
            >
              Not us — search
            </GhostButton>
          </div>
        </div>
      )}

      {(status === 'rejected' || status === 'no_match' || searchOpen) && (
        <div className="space-y-2 mt-3">
          <p className="text-xs text-zinc-500">
            Search for the correct listing by name + city.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Acme Plumbing, Phoenix"
              className="flex-1 px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm text-zinc-100 placeholder-zinc-600"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onSearch();
                }
              }}
            />
            <PrimaryButton
              loading={busy === 'search'}
              onClick={onSearch}
              disabled={!searchQuery.trim()}
            >
              <Search size={12} />
            </PrimaryButton>
          </div>
          {candidates && candidates.length === 0 && (
            <p className="text-xs text-zinc-500">No matches. Try another query.</p>
          )}
          {candidates && candidates.length > 0 && (
            <ul className="space-y-1 mt-2">
              {candidates.map((c) => (
                <li
                  key={c.placeId}
                  className="border rounded-md p-2 cursor-pointer hover:bg-white/[0.03]"
                  style={{ borderColor: 'var(--color-border)' }}
                  onClick={() => onSelect(c.placeId)}
                >
                  <div className="text-sm text-zinc-200">{c.displayName}</div>
                  <div className="text-[11px] text-zinc-500 font-mono">
                    {c.formattedAddress}
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    {[
                      c.primaryType,
                      c.rating !== null ? `${c.rating.toFixed(1)} ★` : null,
                      c.userRatingCount !== null
                        ? `${c.userRatingCount} reviews`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-4 pt-3 border-t flex justify-end" style={{ borderColor: 'var(--color-border)' }}>
        <button
          type="button"
          onClick={async () => {
            setBusy('skip');
            await advance('portal_users');
            setBusy(null);
          }}
          disabled={busy === 'skip'}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          Skip for now →
        </button>
      </div>
    </Card>
  );
}

// ─── Step 2: Portal users ──────────────────────────────────────────────

function PortalUsersStep({
  state,
  post,
  advance,
}: {
  state: WizardState;
  post: (body: Record<string, unknown>) => Promise<boolean>;
  advance: (s: Step) => Promise<boolean>;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<null | 'invite' | 'next'>(null);

  const onInvite = async () => {
    if (!email.trim()) return;
    setBusy('invite');
    const ok = await post({ action: 'invite_user', email: email.trim() });
    if (ok) setEmail('');
    setBusy(null);
  };

  const nextStep: Step = state.tier === 'pulse_plus' ? 'competitors' : 'done';

  return (
    <Card>
      <h2 className="font-display text-xl font-bold mb-1">Invite your team</h2>
      <p className="text-xs text-zinc-500 mb-4">
        Add anyone who should see your TurfMap dashboard — your marketing
        person, agency, business partner. Each gets an email magic link.
        Optional; you can add more later in settings.
      </p>
      <div className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@example.com"
          className="flex-1 px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm text-zinc-100 placeholder-zinc-600"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onInvite();
            }
          }}
        />
        <PrimaryButton
          loading={busy === 'invite'}
          onClick={onInvite}
          disabled={!email.trim()}
        >
          Invite
        </PrimaryButton>
      </div>
      <p className="text-[11px] text-zinc-600 mt-2">
        {state.portalUserCount} invited so far.
      </p>

      <div className="mt-4 pt-3 border-t flex justify-end gap-2" style={{ borderColor: 'var(--color-border)' }}>
        <PrimaryButton
          loading={busy === 'next'}
          onClick={async () => {
            setBusy('next');
            await advance(nextStep);
            setBusy(null);
          }}
        >
          Continue <ArrowRight size={12} />
        </PrimaryButton>
      </div>
    </Card>
  );
}

// ─── Step 3: Competitors (Pulse+ only) ─────────────────────────────────

function CompetitorsStep({
  state,
  post,
  advance,
}: {
  state: WizardState;
  post: (body: Record<string, unknown>) => Promise<boolean>;
  advance: (s: Step) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<null | 'add' | 'next'>(null);

  const onAdd = async () => {
    if (!name.trim()) return;
    setBusy('add');
    const ok = await post({ action: 'add_competitor', name: name.trim() });
    if (ok) setName('');
    setBusy(null);
  };

  return (
    <Card>
      <h2 className="font-display text-xl font-bold mb-1">Track your top 3 competitors</h2>
      <p className="text-xs text-zinc-500 mb-4">
        Pulse+ scans curate ranks against businesses you specifically watch. Add
        the three that matter most to your territory. Skip if you&rsquo;d rather
        let TurfMap auto-discover them from the first scan.
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Competitor business name"
          className="flex-1 px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-sm text-zinc-100 placeholder-zinc-600"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onAdd();
            }
          }}
        />
        <PrimaryButton
          loading={busy === 'add'}
          onClick={onAdd}
          disabled={!name.trim() || state.competitorCount >= 3}
        >
          Add
        </PrimaryButton>
      </div>
      <p className="text-[11px] text-zinc-600 mt-2">
        {state.competitorCount} / 3 added.
      </p>

      <div className="mt-4 pt-3 border-t flex justify-end" style={{ borderColor: 'var(--color-border)' }}>
        <PrimaryButton
          loading={busy === 'next'}
          onClick={async () => {
            setBusy('next');
            await advance('done');
            setBusy(null);
          }}
        >
          {state.competitorCount > 0 ? 'Continue' : 'Skip & continue'} <ArrowRight size={12} />
        </PrimaryButton>
      </div>
    </Card>
  );
}

// ─── Step 4: Done ──────────────────────────────────────────────────────

function DoneStep({ state }: { state: WizardState }) {
  return (
    <Card>
      <div className="text-center py-2">
        <div
          className="w-12 h-12 mx-auto rounded-full flex items-center justify-center mb-4"
          style={{ background: 'rgba(197, 255, 58, 0.12)' }}
        >
          <Check size={22} style={{ color: 'var(--color-lime, #c5ff3a)' }} />
        </div>
        <h2 className="font-display text-2xl font-bold mb-2">
          Your TurfMap is ready.
        </h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-6 max-w-md mx-auto">
          Your first scan is done — head to your TurfMap to see where
          you win and where you don&rsquo;t. Your AI Coach Fix List
          loads with it.
        </p>
        <Link
          href={`/portal/${state.publicId}`}
          className="inline-flex items-center gap-2 rounded-md font-bold text-sm py-2.5 px-5 transition-all hover:brightness-110"
          style={{ background: 'var(--color-lime)', color: 'black' }}
        >
          Open my TurfMap <ArrowRight size={14} />
        </Link>
        <p className="text-[11px] text-zinc-600 mt-6">
          Bookmarks, additional locations, alert preferences, and exports live
          under <span className="text-zinc-400">Settings</span> in the portal.
        </p>
      </div>
    </Card>
  );
}

// ─── Shared atoms ──────────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-lg border p-6"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      {children}
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
  loading,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      className="inline-flex items-center gap-1.5 rounded-md font-bold text-sm py-2 px-3 transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
      style={{ background: 'var(--color-lime)', color: 'black' }}
    >
      {loading ? <Loader2 className="animate-spin" size={12} /> : children}
    </button>
  );
}

function GhostButton({
  children,
  onClick,
  loading,
}: {
  children: React.ReactNode;
  onClick: () => void;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="inline-flex items-center gap-1.5 rounded-md font-medium text-xs py-2 px-3 transition-colors text-zinc-300 hover:text-zinc-100 disabled:opacity-50"
      style={{ background: 'transparent', border: '1px solid var(--color-border)' }}
    >
      {loading ? <Loader2 className="animate-spin" size={12} /> : children}
    </button>
  );
}
