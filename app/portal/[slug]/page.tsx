/**
 * White-label client portal — `/portal/[slug]`.
 *
 * Read-only client-facing view of the same scan data the agency dashboard
 * renders, with three differences:
 *   1. Internal cost data (DFS cost cents) is hidden from the footer.
 *   2. Internal scan controls (Re-scan / scan ID) are hidden.
 *   3. The client's `primary_color` overrides the brand lime accent across
 *      anything that reads `var(--color-lime)`.
 *
 * v1 scope: `[slug]` is the client UUID. Phase 4 may swap to a friendly
 * subdomain or a `clients.slug` column.
 *
 * Auth: Supabase magic-link, gated by membership in `client_users`. Agency
 * staff (rows in `users`) bypass the membership check so we can preview a
 * portal during sales/demos — they see an "Agency preview" tag in the
 * header to make the impersonation obvious.
 */

import { notFound, redirect } from 'next/navigation';
import { AlertTriangle, Compass, Crown, MapPin, Sparkles, Target } from 'lucide-react';
import { getServerSupabase } from '@/lib/supabase/server';
import { getAuthSupabase } from '@/lib/supabase/ssr';
import { SignOutButton } from '@/components/turfmap/SignOutButton';
import type {
  ClientRow,
  ScanPointRow,
  ScanRow,
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

export default async function ClientPortalPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const supabase = getServerSupabase();

  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('id', slug)
    .maybeSingle<ClientRow>();
  if (!client) notFound();

  // ─── auth gate ────────────────────────────────────────────────────────────
  const auth = await getAuthSupabase();
  const {
    data: { user },
  } = await auth.auth.getUser();

  if (!user) {
    redirect(`/portal/${slug}/login`);
  }

  const userEmail = (user.email ?? '').toLowerCase();
  const [{ data: membership }, { data: agencyRow }] = await Promise.all([
    supabase
      .from('client_users')
      .select('id')
      .eq('client_id', slug)
      .eq('email', userEmail)
      .maybeSingle<{ id: string }>(),
    supabase
      .from('users')
      .select('id, role')
      .eq('email', userEmail)
      .maybeSingle<{ id: string; role: string }>(),
  ]);

  // Agency staff get an impersonation override — they can preview any
  // client portal, but the header surfaces a tag so the screen-share is
  // unambiguous.
  const isAgencyPreview = !membership && Boolean(agencyRow);

  if (!membership && !agencyRow) {
    return <NoAccessScreen email={user.email ?? ''} />;
  }
  // ───────────────────────────────────────────────────────────────────────────

  const { data: latestScan } = await supabase
    .from('scans')
    .select('*')
    .eq('client_id', client.id)
    .eq('status', 'complete')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle<ScanRow>();

  const { data: keyword } = latestScan
    ? await supabase
        .from('tracked_keywords')
        .select('*')
        .eq('id', latestScan.keyword_id)
        .maybeSingle<TrackedKeywordRow>()
    : { data: null };

  const { data: rawPoints } = latestScan
    ? await supabase
        .from('scan_points')
        .select('grid_x, grid_y, rank, business_found, competitors')
        .eq('scan_id', latestScan.id)
    : { data: [] as Pick<
        ScanPointRow,
        'grid_x' | 'grid_y' | 'rank' | 'business_found' | 'competitors'
      >[] };

  const points = rawPoints ?? [];
  const cells: HeatmapCell[] = points.map((p) => ({
    x: p.grid_x,
    y: p.grid_y,
    rank: p.rank,
  }));
  const ranks = points.map((p) => p.rank);
  const reach =
    latestScan?.turf_reach != null
      ? Number(latestScan.turf_reach)
      : turfReach(ranks);
  const rank =
    latestScan?.turf_rank != null
      ? Number(latestScan.turf_rank)
      : turfRank(ranks);
  const score =
    latestScan?.turf_score != null
      ? Number(latestScan.turf_score)
      : composeTurfScore(reach, rank);
  const band = getTurfScoreBand(score);
  const momentumValue =
    latestScan?.momentum != null ? Number(latestScan.momentum) : null;
  const { count: completedScanCount } = await supabase
    .from('scans')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', client.id)
    .eq('status', 'complete');
  const isFirstScan = (completedScanCount ?? 0) <= 1;

  const ownNamePattern = new RegExp(
    client.business_name.split(/\s+/)[0] ?? '',
    'i'
  );
  const competitors = aggregateCompetitors(points, points.length || 1, {
    excludeNamePattern: ownNamePattern,
  });

  const { data: insightRow } = latestScan
    ? await supabase
        .from('ai_insights')
        .select('diagnosis, actions, projected_impact')
        .eq('scan_id', latestScan.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle<{
          diagnosis: string;
          actions: AICoachAction[];
          projected_impact: string | null;
        }>()
    : { data: null };

  // Apply per-client brand color via a CSS variable override on the wrapper.
  const accent = client.primary_color ?? '#c5ff3a';
  const wrapperStyle = {
    // overrides anything that reads var(--color-lime)
    ['--color-lime' as string]: accent,
  } as React.CSSProperties;

  return (
    <div className="min-h-screen w-full text-white" style={wrapperStyle}>
      <PortalHeader
        businessName={client.business_name}
        logoUrl={client.logo_url}
        accent={accent}
        userEmail={user.email ?? null}
        isAgencyPreview={isAgencyPreview}
      />

      {latestScan && isFirstScan && (
        <div
          className="px-8 py-3 border-b flex items-center gap-3 text-xs"
          style={{
            background: 'rgba(197, 255, 58, 0.05)',
            borderColor: 'var(--color-border)',
            color: '#a1a1aa',
          }}
        >
          <Sparkles size={14} style={{ color: accent }} />
          <span>
            <span className="text-zinc-200 font-semibold">
              Baseline scan complete.
            </span>{' '}
            This is your starting point — re-scans every 90 days will show
            your territory expanding.
          </span>
        </div>
      )}

      {/* Compact business meta — no scan-trigger / cost data here */}
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

      <div className="grid grid-cols-12 gap-6 p-8">
        <div
          className="col-span-8 border rounded-lg p-6 relative overflow-hidden"
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
                { color: '#c5ff3a', label: 'Top 3' },
                { color: '#e8e54a', label: '4–10' },
                { color: '#ff9f3a', label: '11–20' },
                { color: '#ff4d4d', label: '21+' },
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
            competitors={competitors.map((c): CompetitorView => ({
              ...c,
              cells: buildCompetitorCells(points, c.name),
            }))}
          />
        </div>

        <div className="col-span-4 space-y-4">
          <StatCard
            variant="hero"
            label="TurfScore™"
            value={latestScan ? `${score} / 100` : '—'}
            subtitle="Composite visibility score"
            icon={Target}
            highlight
            band={latestScan ? { label: band.label, tone: band.tone } : undefined}
            tooltip={
              <>
                Your composite visibility score, 0 to 100. Combines how
                much of your territory you cover (TurfReach) with how
                high you rank when you appear (TurfRank). Benchmarks:
                0&ndash;20 invisible, 20&ndash;40 patchy, 40&ndash;60
                solid, 60&ndash;80 dominant, 80+ rare air.
              </>
            }
          />
          <div className="grid grid-cols-2 gap-4">
            <StatCard
              label="TurfReach™"
              value={latestScan ? `${reach}%` : '—'}
              subtitle={
                latestScan
                  ? `Visible in ${reach}% of your territory`
                  : 'Coverage of your territory'
              }
              icon={Compass}
              tooltip={
                <>
                  The percentage of your service area where you appear
                  in Google&rsquo;s local 3-pack. Measured across an
                  81-point grid covering your territory.
                </>
              }
            />
            <StatCard
              label="TurfRank™"
              value={
                latestScan && rank !== null ? `${rank.toFixed(1)} / 3` : '—'
              }
              subtitle={turfRankCaption(rank)}
              icon={Crown}
              tooltip={
                <>
                  Your average position in the local 3-pack across the
                  cells where you appear. 3.0 = always #1, 2.0 = always
                  #2, 1.0 = always #3. Higher is better.
                </>
              }
            />
          </div>
          {latestScan && !isFirstScan && (
            <MomentumCard momentum={momentumValue} />
          )}
          <CompetitorTable competitors={competitors} />
        </div>

        <div className="col-span-12">
          <AICoach
            scanId={latestScan?.id ?? null}
            insight={insightRow ?? null}
            scanComplete={Boolean(latestScan)}
          />
        </div>
      </div>

      <footer
        className="border-t px-8 py-4 flex items-center justify-between text-xs text-zinc-600"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <span>
          Powered by <span className="font-semibold text-zinc-400">TurfMap™</span> · proprietary technology of{' '}
          <span className="text-zinc-300 font-semibold">
            Fourdots Digital
          </span>
        </span>
        {latestScan && (
          <span className="font-mono">
            Last scan{' '}
            {new Date(latestScan.completed_at ?? latestScan.created_at!)
              .toISOString()
              .replace('T', ' ')
              .slice(0, 16)}{' '}
            UTC
          </span>
        )}
      </footer>
    </div>
  );
}

/**
 * Portal header. Uses the client's logo if present, falling back to a
 * generic letter-mark in the lime-square style. Hides agency-side branding
 * meta (system status pill, version label).
 */
function PortalHeader({
  businessName,
  logoUrl,
  accent,
  userEmail,
  isAgencyPreview,
}: {
  businessName: string;
  logoUrl: string | null;
  accent: string;
  userEmail: string | null;
  isAgencyPreview: boolean;
}) {
  const initial = businessName.trim().charAt(0).toUpperCase() || 'T';
  return (
    <header
      className="border-b px-8 py-5 flex items-center justify-between"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-center gap-3">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl}
            alt={businessName}
            className="w-9 h-9 rounded-md object-cover"
            style={{ boxShadow: `0 0 24px ${accent}40` }}
          />
        ) : (
          <div
            className="w-9 h-9 rounded-md flex items-center justify-center font-display font-bold text-black"
            style={{
              background: accent,
              boxShadow: `0 0 24px ${accent}40`,
            }}
          >
            {initial}
          </div>
        )}
        <div>
          <div className="font-display text-xl font-bold tracking-tight leading-none">
            {businessName}
          </div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mt-0.5">
            Local visibility report
          </div>
        </div>
      </div>
      {userEmail && (
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          {isAgencyPreview && (
            <span
              className="px-2 py-1 rounded text-[10px] uppercase tracking-[0.18em] font-bold"
              style={{
                background: 'rgba(197, 255, 58, 0.12)',
                color: 'var(--color-lime, #c5ff3a)',
                border: '1px solid rgba(197, 255, 58, 0.3)',
              }}
              title="You're viewing this client's portal as agency staff. The client doesn't see this tag."
            >
              Agency preview
            </span>
          )}
          <span className="font-mono truncate max-w-[200px]">{userEmail}</span>
          <SignOutButton />
        </div>
      )}
    </header>
  );
}

function NoAccessScreen({ email }: { email: string }) {
  return (
    <div className="min-h-screen w-full text-white flex items-center justify-center px-6">
      <div
        className="max-w-md w-full rounded-lg border p-8 text-center"
        style={{
          background: 'var(--color-card)',
          borderColor: '#3a1010',
        }}
      >
        <div
          className="w-12 h-12 rounded-full mx-auto mb-4 flex items-center justify-center"
          style={{ background: '#1a0a0a', border: '1px solid #3a1010' }}
        >
          <AlertTriangle size={20} className="text-red-400" />
        </div>
        <h3 className="font-display text-lg font-bold mb-2">No access to this portal</h3>
        <p className="text-xs text-zinc-400 leading-relaxed mb-5">
          Your account <span className="font-mono text-zinc-200">{email}</span> isn&apos;t on the
          access list for this client. Contact your account manager if you think this is wrong.
        </p>
        <div className="flex justify-center">
          <SignOutButton size="md" />
        </div>
      </div>
    </div>
  );
}
