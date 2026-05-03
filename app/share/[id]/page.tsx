/**
 * Public share view for a single scan — `/share/[id]`.
 *
 * No auth required. Hits a `scan_share_links` row by id; if expired,
 * revoked, or missing, renders an "Expired" screen. Otherwise renders
 * a portal-style read-only dashboard with all the score cards,
 * heatmap, competitor list, and AI Coach playbook.
 *
 * Differs from /portal/<id> in that there's no white-label client
 * branding (the audience may not yet be a client) — TurfMap lime
 * accent, plus an optional agency_label / cta surfaced at the top
 * and bottom respectively. Internal stuff (DFS cost, scan IDs, scan
 * controls) is hidden as in the portal view.
 *
 * Side effect: increments scan_share_links.view_count + stamps
 * last_viewed_at on every render. v1 — no dedup. Sales-funnel
 * signal is more useful than precision here.
 *
 * force-dynamic so the view counter ticks on every fetch and the
 * expiry check never serves a stale "active" page.
 */

import { Crosshair, Crown, MapPin, Target, Compass, ChevronRight, Clock } from 'lucide-react';
import Link from 'next/link';
import { getServerSupabase } from '@/lib/supabase/server';
import type {
  ClientRow,
  ScanPointRow,
  ScanRow,
  ScanShareLinkRow,
  TrackedKeywordRow,
} from '@/lib/supabase/types';
import { turfReach } from '@/lib/metrics/turfReach';
import { turfRank, turfRankCaption } from '@/lib/metrics/turfRank';
import { composeTurfScore } from '@/lib/metrics/turfScoreComposite';
import { getTurfScoreBand } from '@/lib/metrics/turfScoreBands';
import { aggregateCompetitors } from '@/lib/metrics/competitors';
import type { HeatmapCell } from '@/components/turfmap/HeatmapGrid';
import {
  HeatmapWithToggle,
  type CompetitorView,
} from '@/components/turfmap/HeatmapWithToggle';
import { StatCard } from '@/components/turfmap/StatCard';
import { MomentumCard } from '@/components/turfmap/MomentumCard';
import { CompetitorTable } from '@/components/turfmap/CompetitorTable';
import { AICoach, type AICoachAction } from '@/components/turfmap/AICoach';
import { buildCompetitorCells } from '@/lib/metrics/competitorCells';

export const dynamic = 'force-dynamic';

export default async function PublicSharePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: shareId } = await params;
  const supabase = getServerSupabase();

  // 1. Look up the share link itself.
  const { data: share } = await supabase
    .from('scan_share_links')
    .select('*')
    .eq('id', shareId)
    .maybeSingle<ScanShareLinkRow>();
  if (!share) return <ExpiredScreen reason="not_found" />;

  if (share.revoked_at) return <ExpiredScreen reason="revoked" />;
  if (new Date(share.expires_at).getTime() < Date.now()) {
    return <ExpiredScreen reason="expired" expiresAt={share.expires_at} />;
  }

  // 2. Bump the view counter (best-effort; never block render on it).
  void supabase
    .from('scan_share_links')
    .update({
      view_count: (share.view_count ?? 0) + 1,
      last_viewed_at: new Date().toISOString(),
    })
    .eq('id', shareId);

  // 3. Load the scan + everything we need to render the dashboard view.
  const { data: scan } = await supabase
    .from('scans')
    .select('*')
    .eq('id', share.scan_id)
    .maybeSingle<ScanRow>();
  if (!scan) return <ExpiredScreen reason="not_found" />;

  const [{ data: client }, { data: keyword }, { data: rawPoints }] =
    await Promise.all([
      supabase
        .from('clients')
        .select('*')
        .eq('id', scan.client_id)
        .maybeSingle<ClientRow>(),
      supabase
        .from('tracked_keywords')
        .select('*')
        .eq('id', scan.keyword_id)
        .maybeSingle<TrackedKeywordRow>(),
      supabase
        .from('scan_points')
        .select('grid_x, grid_y, rank, business_found, competitors')
        .eq('scan_id', scan.id)
        .returns<
          Pick<
            ScanPointRow,
            'grid_x' | 'grid_y' | 'rank' | 'business_found' | 'competitors'
          >[]
        >(),
    ]);
  if (!client) return <ExpiredScreen reason="not_found" />;

  const points = rawPoints ?? [];
  const cells: HeatmapCell[] = points.map((p) => ({
    x: p.grid_x,
    y: p.grid_y,
    rank: p.rank,
  }));
  const ranks = points.map((p) => p.rank);

  const reach =
    scan.turf_reach != null ? Number(scan.turf_reach) : turfReach(ranks);
  const rank =
    scan.turf_rank != null ? Number(scan.turf_rank) : turfRank(ranks);
  const score =
    scan.turf_score != null
      ? Number(scan.turf_score)
      : composeTurfScore(reach, rank);
  const band = getTurfScoreBand(score);
  const momentumValue =
    scan.momentum != null ? Number(scan.momentum) : null;

  const ownNamePattern = new RegExp(
    client.business_name.split(/\s+/)[0] ?? '',
    'i'
  );
  const competitors = aggregateCompetitors(points, points.length || 1, {
    excludeNamePattern: ownNamePattern,
  });

  const { data: insightRow } = await supabase
    .from('ai_insights')
    .select('diagnosis, actions, projected_impact')
    .eq('scan_id', scan.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{
      diagnosis: string;
      actions: AICoachAction[];
      projected_impact: string | null;
    }>();

  const expiresAtFormatted = new Date(share.expires_at).toLocaleDateString(
    'en-US',
    { month: 'long', day: 'numeric', year: 'numeric' }
  );
  const sharedBy = share.agency_label?.trim() || 'Fourdots Digital';
  const ctaText = share.cta_text?.trim() || 'Want a TurfMap of your business?';
  const ctaUrl = share.cta_url?.trim() || 'https://localleadmachine.io';

  return (
    <div className="min-h-screen w-full text-white">
      {/* Branded header — not white-labeled because the audience hasn't
          signed up yet. TurfMap-branded so the tool gets the credit. */}
      <header
        className="border-b px-8 py-5 flex items-center justify-between"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-md flex items-center justify-center"
            style={{
              background: 'var(--color-lime)',
              boxShadow: '0 0 24px #c5ff3a40',
            }}
          >
            <Crosshair size={18} className="text-black" strokeWidth={2.5} />
          </div>
          <div>
            <div className="font-display text-xl font-bold leading-tight">
              TurfMap.ai
            </div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mt-0.5">
              Local visibility report
            </div>
          </div>
        </div>
        <div className="text-xs text-zinc-500 font-mono flex items-center gap-2">
          <Clock size={12} />
          Expires {expiresAtFormatted}
        </div>
      </header>

      {/* "Shared by" banner — gives the recipient a face/agency to
          attribute the report to. */}
      <div
        className="px-8 py-3 border-b text-xs text-zinc-400"
        style={{
          background: '#0d130a',
          borderColor: 'var(--color-border)',
        }}
      >
        Shared by{' '}
        <span className="text-zinc-200 font-semibold">{sharedBy}</span> · this
        is a read-only snapshot of {client.business_name}&rsquo;s territory
        for the keyword{' '}
        <span className="font-mono text-zinc-300">
          &ldquo;{keyword?.keyword ?? '—'}&rdquo;
        </span>
        .
      </div>

      {/* Compact business meta */}
      <div
        className="border-b px-8 py-4 grid grid-cols-12 gap-4 items-center"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="col-span-4">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1.5 font-semibold">
            Business
          </div>
          <div className="text-sm font-medium text-zinc-100">
            {client.business_name}
          </div>
        </div>
        <div className="col-span-4">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1.5 font-semibold">
            Pin Location
          </div>
          <div className="text-sm flex items-center gap-1.5 text-zinc-200">
            <MapPin size={13} className="text-zinc-500" />
            {client.address}
          </div>
        </div>
        <div className="col-span-4">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1.5 font-semibold">
            Tracked Keyword
          </div>
          <div className="text-sm font-mono text-zinc-200">
            {keyword?.keyword ?? '—'}
          </div>
        </div>
      </div>

      {/* Heatmap + sidebar — same shape as portal/dashboard but
          internals stripped out. */}
      <div className="grid grid-cols-12 gap-6 p-8">
        <div
          className="col-span-8 border rounded-lg p-6 relative"
          style={{
            background: 'var(--color-card)',
            borderColor: 'var(--color-border)',
          }}
        >
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="font-display text-xl font-bold">
                Territory Heatmap
              </h3>
              <p className="text-xs text-zinc-500">
                9×9 geo-grid · 81 search points ·{' '}
                {client.service_radius_miles ?? 1.6}mi radius
              </p>
            </div>
            <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider">
              {[
                { color: '#c5ff3a', label: '#1' },
                { color: '#e8e54a', label: '#2' },
                { color: '#ff9f3a', label: '#3' },
                { color: '#ff4d4d', label: 'Not in pack' },
              ].map((item) => (
                <div key={item.label} className="flex items-center gap-1.5">
                  <div
                    className="w-2.5 h-2.5 rounded-sm"
                    style={{ background: item.color }}
                  />
                  <span className="text-zinc-400">{item.label}</span>
                </div>
              ))}
            </div>
          </div>
          <HeatmapWithToggle
            clientCells={cells}
            clientName={client.business_name}
            competitors={competitors.map(
              (c): CompetitorView => ({
                ...c,
                cells: buildCompetitorCells(points, c.name),
              })
            )}
          />
        </div>

        <div className="col-span-4 space-y-4">
          <StatCard
            variant="hero"
            label="TurfScore™"
            value={`${score} / 100`}
            subtitle="Composite visibility score"
            icon={Target}
            highlight
            band={{ label: band.label, tone: band.tone }}
          />
          <div className="grid grid-cols-2 gap-4">
            <StatCard
              label="TurfReach™"
              value={`${reach}%`}
              subtitle={`Visible in ${reach}% of your territory`}
              icon={Compass}
            />
            <StatCard
              label="TurfRank™"
              value={rank !== null ? `${rank.toFixed(1)} / 3` : '—'}
              subtitle={turfRankCaption(rank)}
              icon={Crown}
            />
          </div>
          {momentumValue !== null && <MomentumCard momentum={momentumValue} />}
          <CompetitorTable competitors={competitors} />
        </div>

        <div className="col-span-12">
          <AICoach
            scanId={null}
            insight={insightRow ?? null}
            scanComplete={Boolean(scan)}
          />
        </div>
      </div>

      {/* CTA footer — the conversion lever. Points to the agency's
          chosen URL (Local Lead Machine by default). */}
      <footer
        className="border-t px-8 py-6 flex items-center justify-between"
        style={{
          background:
            'linear-gradient(135deg, var(--color-card) 0%, var(--color-card-glow) 100%)',
          borderColor: 'var(--color-border-bright)',
        }}
      >
        <div>
          <div className="font-display text-lg font-bold mb-1 text-zinc-100">
            {ctaText}
          </div>
          <div className="text-xs text-zinc-500">
            This snapshot was prepared by{' '}
            <span className="text-zinc-300">{sharedBy}</span>. TurfMap is
            proprietary technology of Fourdots Digital.
          </div>
        </div>
        <a
          href={ctaUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="px-5 py-2.5 rounded-md font-bold text-sm flex items-center gap-2 transition-all hover:brightness-110"
          style={{
            background: 'var(--color-lime)',
            color: 'black',
            boxShadow: '0 4px 16px #c5ff3a30',
          }}
        >
          Get in touch
          <ChevronRight size={14} strokeWidth={2.75} />
        </a>
      </footer>
    </div>
  );
}

function ExpiredScreen({
  reason,
  expiresAt,
}: {
  reason: 'expired' | 'revoked' | 'not_found';
  expiresAt?: string;
}) {
  const headline =
    reason === 'expired'
      ? 'This share link has expired'
      : reason === 'revoked'
        ? 'This share link has been revoked'
        : 'Share link not found';
  const body =
    reason === 'expired'
      ? `This snapshot was last accessible until ${expiresAt ? new Date(expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'recently'}. Ask whoever sent it for a fresh link.`
      : reason === 'revoked'
        ? 'The agency that created this link has revoked it. Reach out to them for an updated copy.'
        : 'The link may be mistyped or the share has been deleted. Double-check the URL.';

  return (
    <div className="min-h-screen w-full text-white flex items-center justify-center px-6">
      <div
        className="max-w-md w-full rounded-lg border p-8 text-center"
        style={{
          background: 'var(--color-card)',
          borderColor: 'var(--color-border)',
        }}
      >
        <div
          className="w-12 h-12 rounded-full mx-auto mb-4 flex items-center justify-center"
          style={{
            background: '#0d130a',
            border: '1px solid var(--color-border-bright)',
          }}
        >
          <Clock size={20} style={{ color: 'var(--color-lime)' }} />
        </div>
        <h3 className="font-display text-lg font-bold mb-2">{headline}</h3>
        <p className="text-xs text-zinc-400 leading-relaxed mb-5">{body}</p>
        <Link
          href="https://localleadmachine.io"
          className="text-xs font-mono text-zinc-500 hover:text-zinc-300"
        >
          localleadmachine.io →
        </Link>
      </div>
    </div>
  );
}
