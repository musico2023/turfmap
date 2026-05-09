/**
 * /dev/audit-fixture — readable viewer for the Phase 1 Visibility Audit
 * pipeline output. Calls /api/dev/audit-fixture against one of three
 * mock buyer profiles and renders the fit breakdown, generated
 * roadmap, and strategist prep markdown in a layout we can actually
 * read.
 *
 * Same gate as /dev/email-preview — fourdots-domain emails only.
 * Internal QA tool; never linked from the public site.
 *
 * Each profile button hits Claude (Sonnet 4.6 × 2 calls per render),
 * so flipping between profiles repeatedly burns ~$0.30 each time.
 * Cheap enough for QA but not free; cache is fine because the
 * fixture inputs are deterministic.
 */

import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Header } from '@/components/turfmap/Header';
import {
  isAgencyOwnerEmail,
  requireAgencyUserOrRedirect,
} from '@/lib/auth/agency';
import { DownloadPdfButton } from './DownloadPdfButton';
import type {
  ActionCategory,
  ActionPriority,
  DifficultyRating,
} from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';

const PROFILES = [
  {
    key: 'high',
    label: 'HIGH FIT — HVAC, major metro, ad-active',
    blurb:
      'Northwoods Heating & Cooling. TurfScore 38. Should land Fit 5; LLM segue should pitch.',
  },
  {
    key: 'medium',
    label: 'MEDIUM FIT — plumber, mid-market, no ad signal',
    blurb:
      'Riverline Plumbing. TurfScore 47. Should land Fit 3 (mid-band, ad signal unknown). Talking points should suppress LLM pitch.',
  },
  {
    key: 'low',
    label: 'LOW FIT — small landscaper, small market, low reviews',
    blurb:
      'Greenline Lawn Care. TurfScore 22. Should land Fit 1 (small-market disqualifier + low review count). Diagnosis only.',
  },
] as const;

// ─── Page entry: profile picker ────────────────────────────────────────

export default async function AuditFixturePage({
  searchParams,
}: {
  searchParams: Promise<{ profile?: string }>;
}) {
  const me = await requireAgencyUserOrRedirect('/dev/audit-fixture');
  if (!isAgencyOwnerEmail(me.email)) notFound();

  const params = await searchParams;
  const profileKey = params.profile;

  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={me.email} />
      <div className="px-8 py-6 max-w-5xl">
        <h1 className="font-display text-2xl font-bold">
          Audit pipeline fixture viewer
        </h1>
        <p className="text-xs text-zinc-500 mt-1 mb-6 max-w-2xl">
          Phase 1 of the Visibility Audit pipeline. Pick a profile to
          run the full pipeline (Fit Score → Roadmap → Strategist Prep
          Notes) against a mock buyer. Each render hits Claude twice
          (~$0.30) and takes ~15 seconds.
        </p>

        <div className="space-y-2 mb-8">
          {PROFILES.map((p) => (
            <Link
              key={p.key}
              href={`/dev/audit-fixture?profile=${p.key}`}
              className="block border rounded-lg p-4 transition-colors hover:bg-white/[0.03]"
              style={{
                background: 'var(--color-card)',
                borderColor:
                  profileKey === p.key
                    ? 'var(--color-lime)'
                    : 'var(--color-border)',
              }}
            >
              <div className="font-mono text-sm font-semibold">
                {p.label}
              </div>
              <div className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
                {p.blurb}
              </div>
            </Link>
          ))}
        </div>

        {profileKey ? <FixtureResult profileKey={profileKey} /> : null}
      </div>
    </div>
  );
}

// ─── Server-side fetch + render ────────────────────────────────────────

async function FixtureResult({ profileKey }: { profileKey: string }) {
  // Re-derive the absolute origin so we can call our own API route
  // server-side. The fetch needs cookie-bound auth, so we pass the
  // incoming Cookie header through.
  const hdrs = await headers();
  const proto = hdrs.get('x-forwarded-proto') ?? 'https';
  const host =
    hdrs.get('x-forwarded-host') ?? hdrs.get('host') ?? 'localhost:3000';
  const origin = `${proto}://${host}`;
  const cookie = hdrs.get('cookie') ?? '';

  let payload: FixturePayload | { error: string };
  try {
    const res = await fetch(
      `${origin}/api/dev/audit-fixture?profile=${encodeURIComponent(profileKey)}`,
      {
        cache: 'no-store',
        headers: { cookie },
      }
    );
    if (!res.ok) {
      payload = {
        error: `API returned ${res.status}: ${await res.text()}`,
      };
    } else {
      payload = (await res.json()) as FixturePayload;
    }
  } catch (e) {
    payload = {
      error: e instanceof Error ? e.message : String(e),
    };
  }

  if ('error' in payload) {
    return (
      <div
        className="border rounded-lg p-5"
        style={{
          background: 'var(--color-card)',
          borderColor: '#ef4444',
        }}
      >
        <div className="font-mono text-sm font-semibold text-red-400 mb-2">
          Fixture run failed
        </div>
        <pre className="text-xs text-zinc-300 whitespace-pre-wrap">
          {payload.error}
        </pre>
      </div>
    );
  }

  // Assemble the PDF payload from the API response. The PDF takes
  // a different shape than the API returns (fields renamed +
  // flattened); we transform once here so the client island gets
  // exactly what the /api/audit/preview-pdf endpoint validates.
  const pdfPayload = {
    businessName: payload.buyer.businessName,
    trade: payload.buyer.trade,
    market: payload.buyer.market,
    auditDate: payload.buyer.auditDate,
    currentTurfScore: payload.buyer.currentTurfScore,
    projectedTurfScore: payload.buyer.projectedTurfScore,
    diagnosis: payload.roadmap.diagnosis,
    actions: payload.roadmap.actions.map((a) => ({
      week: a.week,
      action: a.action,
      category: a.category as ActionCategory,
      difficulty: a.difficulty as DifficultyRating,
      priority: a.priority as ActionPriority,
      projectedScoreLift: a.projectedScoreLift,
      llmCovered: a.llmCovered,
    })),
    napFindings: payload.buyer.napFindings,
    competitors: payload.buyer.competitors,
    ninetyDayTargetLift: payload.roadmap.ninetyDayTargetLift,
  };

  return (
    <div className="space-y-6">
      <FitBreakdownCard payload={payload} />
      <RoadmapCard payload={payload} />
      <PrepCard payload={payload} />
      <div
        className="border rounded-lg p-5"
        style={{
          background: 'var(--color-card)',
          borderColor: 'var(--color-border-bright)',
        }}
      >
        <h2 className="font-display text-lg font-semibold mb-2">
          Preview the deliverable
        </h2>
        <p className="text-xs text-zinc-500 mb-4 leading-relaxed">
          Renders the in-memory roadmap as a 6-page PDF and downloads
          it. Same template the production fulfillment pipeline will
          use; storage upload + buyer-facing email are deferred to
          Phase 3.
        </p>
        <DownloadPdfButton payload={pdfPayload} />
      </div>
    </div>
  );
}

// ─── Display cards ─────────────────────────────────────────────────────

function FitBreakdownCard({ payload }: { payload: FixturePayload }) {
  const f = payload.fit;
  return (
    <Card title={`LLM Fit Score — ${f.score}/5`} accent>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs font-mono mb-3">
        <Stat label="Revenue band" value={f.inputs.revenue_band ?? 'unknown'} />
        <Stat label="Trade fit" value={String(f.inputs.trade_fit ?? 'unknown')} />
        <Stat label="Metro fit" value={String(f.inputs.metro_fit ?? 'unknown')} />
        <Stat label="Ad active" value={String(f.inputs.ad_active ?? 'unknown')} />
        <Stat label="Review count" value={String(f.inputs.review_count ?? 'unknown')} />
      </div>
      <div className="text-xs text-zinc-500 mb-1">Rules fired:</div>
      <div className="flex flex-wrap gap-1.5">
        {f.rule_hits.map((h) => (
          <span
            key={h}
            className="text-[10px] font-mono px-2 py-0.5 rounded"
            style={{
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              color: h.startsWith('disqualifier:')
                ? '#f87171'
                : h.startsWith('positive:')
                  ? 'var(--color-lime)'
                  : '#a1a1aa',
            }}
          >
            {h}
          </span>
        ))}
      </div>
    </Card>
  );
}

function RoadmapCard({ payload }: { payload: FixturePayload }) {
  const r = payload.roadmap;
  return (
    <Card
      title={`Roadmap — ${r.thirtyDayTargetLift}pt target / ${r.ninetyDayTargetLift}pt 90-day`}
    >
      <div className="text-xs text-zinc-300 italic mb-4 leading-relaxed">
        “{r.diagnosis}”
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b" style={{ borderColor: 'var(--color-border)' }}>
              <Th>Wk</Th>
              <Th>Action</Th>
              <Th>Category</Th>
              <Th>Difficulty</Th>
              <Th>Priority</Th>
              <Th>+pts</Th>
              <Th>📍 LLM</Th>
            </tr>
          </thead>
          <tbody>
            {r.actions.map((a, i) => (
              <tr
                key={i}
                className="border-b"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <Td mono>{a.week}</Td>
                <Td>{a.action}</Td>
                <Td mono dim>{a.category}</Td>
                <Td mono dim>{a.difficulty}</Td>
                <Td
                  mono
                  style={{
                    color:
                      a.priority === 'HIGH'
                        ? '#ff9f3a'
                        : a.priority === 'MEDIUM'
                          ? '#facc15'
                          : '#a1a1aa',
                  }}
                >
                  {a.priority}
                </Td>
                <Td mono>+{a.projectedScoreLift}</Td>
                <Td>{a.llmCovered ? '📍' : ''}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[10px] text-zinc-600 font-mono mt-2">
        Generator: {r.generatorVersion}
      </div>
    </Card>
  );
}

function PrepCard({ payload }: { payload: FixturePayload }) {
  return (
    <Card title="Strategist Prep Notes (markdown)">
      <pre
        className="text-xs leading-relaxed whitespace-pre-wrap"
        style={{ color: '#e4e4e7' }}
      >
        {payload.prep.markdown}
      </pre>
      <div className="text-[10px] text-zinc-600 font-mono mt-3">
        Selected segues:{' '}
        {payload.prep.selectedSegues.map((s) => s.id).join(', ') || 'none'}
        {' · '}Generator: {payload.prep.version}
      </div>
    </Card>
  );
}

// ─── Card primitives ───────────────────────────────────────────────────

function Card({
  title,
  accent = false,
  children,
}: {
  title: string;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="border rounded-lg p-5"
      style={{
        background: 'var(--color-card)',
        borderColor: accent
          ? 'var(--color-border-bright)'
          : 'var(--color-border)',
      }}
    >
      <h2 className="font-display text-lg font-semibold mb-3">{title}</h2>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-zinc-500">{label}: </span>
      <span className="text-zinc-200">{value}</span>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-left py-2 pr-3 font-mono text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
      {children}
    </th>
  );
}

function Td({
  children,
  mono = false,
  dim = false,
  style,
}: {
  children: React.ReactNode;
  mono?: boolean;
  dim?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <td
      className={`py-2 pr-3 align-top ${mono ? 'font-mono' : ''} ${dim ? 'text-zinc-500' : 'text-zinc-200'}`}
      style={style}
    >
      {children}
    </td>
  );
}

// ─── Local types matching the API response shape ──────────────────────

type FixturePayload = {
  profile: string;
  label: string;
  buyer: {
    businessName: string;
    trade: string;
    market: string;
    currentTurfScore: number;
    projectedTurfScore: number;
    auditDate: string;
    napFindings: Array<{
      status: 'MISSING' | 'INCONSISTENT' | 'LIVE';
      text: string;
    }>;
    competitors: Array<{
      name: string;
      turfScore: number;
      differential?: string;
    }>;
  };
  fit: {
    score: number;
    inputs: {
      revenue_band: string | null;
      trade_fit: boolean | null;
      metro_fit: boolean | null;
      ad_active: boolean | null;
      review_count: number | null;
    };
    rule_hits: string[];
  };
  roadmap: {
    diagnosis: string;
    thirtyDayTargetLift: number;
    ninetyDayTargetLift: number;
    generatorVersion: string;
    actions: Array<{
      week: number;
      action: string;
      category: string;
      difficulty: string;
      priority: string;
      projectedScoreLift: number;
      llmCovered: boolean;
    }>;
  };
  prep: {
    version: string;
    keyFindings: string[];
    competitiveContext: string;
    selectedSegues: Array<{ id: string; likelyProblem: string; verbatim: string }>;
    talkingPoints: string[];
    markdown: string;
  };
};
