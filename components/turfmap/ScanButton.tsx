'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Radio, Search, Tag } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ScanProgress } from './ScanProgress';

export type RescanCap = {
  count: number;
  limit: number;
  atCap: boolean;
  nextAvailableAt: string | null;
};

export type ScanButtonProps = {
  clientId: string;
  /** Optional — which physical location to scan. Defaults to the client's
   *  primary location server-side when not supplied. Multi-location clients
   *  pass the active location's id from the dashboard. */
  locationId?: string | null;
  /** Optional — which keyword to scan. Defaults to the location's primary
   *  keyword server-side when omitted. The dashboard passes the active
   *  keyword id so re-scanning targets whichever keyword the operator is
   *  currently viewing. */
  keywordId?: string | null;
  /** Drives the button label (Re-scan vs Run TurfScan) and the icon.
   *  Pass when a prior scan exists for the active (location, keyword)
   *  pair; omit otherwise. */
  keywordLabel?: string;
  /** Server-fetched cap status for THIS location's last 24h of on-demand
   *  scans. Drives the disabled state + the X/N badge under the button.
   *  Optional for back-compat; absence = no rate-limit display. */
  rescanCap?: RescanCap | null;
  /** Whether the active location has at least one keyword scoped to it.
   *  When false, the button renders disabled with a "Add a keyword to
   *  scan this location" affordance — required since a multi-location
   *  client can have one location without a keyword while sibling
   *  locations have plenty (the Sugar Daddy Doughnuts Union Station
   *  case). Pre-fix the button stayed enabled in that state and a
   *  click would silently scan a sibling location's keyword against
   *  the wrong grid, returning 0/100. */
  hasKeyword?: boolean;
  /** Public_id used to deep-link the operator into Settings →
   *  Keywords when hasKeyword=false. Required when hasKeyword is
   *  explicitly false; ignored otherwise. */
  clientPublicId?: string;
};

/**
 * Triggers POST /api/scans/trigger and refreshes the page on success so the
 * server component re-fetches the latest scan. The whole flow takes ~15-30s
 * because we're synchronous all the way through DFS — the button blocks
 * during that window.
 *
 * Rate-limit UX: the dashboard pre-fetches the rolling-24h scan count for
 * this location and passes it as `rescanCap`. When at the cap (3/3 in v1),
 * the button renders disabled with "Daily limit reached · next at HH:MM"
 * so the operator knows why and when. Server-side enforcement still
 * applies — the button is just a faster signal than waiting for a 429.
 */
export function ScanButton({
  clientId,
  locationId,
  keywordId,
  keywordLabel,
  rescanCap,
  hasKeyword = true,
  clientPublicId,
}: ScanButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = isScanning || isPending;
  const atCap = rescanCap?.atCap === true;
  // Three independent reasons to disable the button. hasKeyword is
  // the new gate — without it the dashboard's fallback could pass
  // through a sibling location's keyword id and the trigger route
  // would happily scan the wrong territory.
  const noKeyword = hasKeyword === false;
  const disabled = busy || atCap || noKeyword;

  const onClick = async () => {
    setError(null);
    setIsScanning(true);
    try {
      const res = await fetch('/api/scans/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          locationId: locationId ?? undefined,
          keywordId: keywordId ?? undefined,
        }),
      });
      // Read as text first so we can produce a useful error if Vercel
      // returns an HTML error page (function timeout, OOM, build error)
      // instead of our JSON envelope.
      const text = await res.text();
      let data: { error?: string; rateLimit?: RescanCap } | null = null;
      try {
        data = JSON.parse(text) as { error?: string; rateLimit?: RescanCap };
      } catch {
        // Non-JSON response — most likely a Vercel infra error page.
        const snippet = text.slice(0, 140).replace(/\s+/g, ' ').trim();
        setError(
          `scan failed (HTTP ${res.status}). Response wasn't JSON — likely a function timeout or crash. Check Vercel logs. Body: "${snippet}…"`
        );
        setIsScanning(false);
        return;
      }
      if (!res.ok) {
        // 429 sends back the cap object; refresh the page so the
        // server-rendered button picks up the new disabled state.
        if (res.status === 429) {
          setError(
            data?.error ??
              'rate limit reached for this location — try again later'
          );
          startTransition(() => router.refresh());
          return;
        }
        setError(data?.error ?? `scan failed (HTTP ${res.status})`);
        setIsScanning(false);
        return;
      }
      // refresh the server component so the new scan shows up
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsScanning(false);
    }
  };

  // Three button states:
  //   no-keyword → "Add a keyword to scan" + Tag icon, secondary variant
  //   at-cap     → "Daily limit reached" + Lock icon, amber-tinted
  //   default    → "Run TurfScan" / "Re-scan turf" + Radio/Search icon
  //
  // The no-keyword state takes precedence over at-cap (no point telling
  // the operator they're rate-limited when there's nothing to scan).
  const label = noKeyword
    ? 'Add a keyword to scan'
    : atCap
      ? 'Daily limit reached'
      : keywordLabel
        ? 'Re-scan turf'
        : 'Run TurfScan';
  const icon = noKeyword ? (
    <Tag size={14} strokeWidth={2.5} />
  ) : atCap ? (
    <Lock size={14} strokeWidth={2.5} />
  ) : keywordLabel ? (
    <Radio size={14} strokeWidth={2.75} />
  ) : (
    <Search size={14} strokeWidth={2.75} />
  );

  // At-cap appearance — base secondary variant, then layered with an
  // amber-tinted style override so it reads as an active *constraint*
  // (operationally meaningful: "you're rate-limited, here's when you
  // can scan again") rather than a default disabled/dim button. Pre-
  // bump it blended into the chrome row and operators didn't notice.
  //
  // No-keyword uses the same visual language as at-cap (constraint
  // tone) but in a quieter zinc rather than amber — it's not an
  // error, just an instruction.
  const constraintStyle = noKeyword
    ? {
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
        color: '#a1a1aa',
      }
    : atCap
      ? {
          background: '#1a1308',
          borderColor: '#3a2a0a',
          color: '#f5b651',
        }
      : undefined;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button
        variant={noKeyword || atCap ? 'secondary' : 'primary'}
        size="lg"
        onClick={onClick}
        disabled={disabled}
        loading={busy}
        loadingLabel="Scanning territory…"
        leftIcon={icon}
        style={constraintStyle}
        title={
          noKeyword
            ? 'No tracked keyword for this location. Add one in Settings to enable scanning.'
            : atCap
              ? `Daily on-demand scan limit reached (${rescanCap?.count}/${rescanCap?.limit}). Next slot ${formatNextAvailable(rescanCap?.nextAvailableAt) ?? 'soon'}.`
              : undefined
        }
      >
        {label}
      </Button>
      {/* No-keyword affordance — link to Settings → Keywords. The
       *  button is disabled (correct: scanning without a keyword
       *  shouldn't fire), but the operator needs an obvious next
       *  step, so we render a small explanatory caption + link. */}
      {noKeyword && clientPublicId && (
        <a
          href={`/clients/${clientPublicId}/settings#keywords`}
          className="text-[10px] font-mono text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          add one in Settings →
        </a>
      )}
      {!noKeyword && rescanCap && !atCap && rescanCap.count > 0 && (
        <span className="text-[10px] font-mono text-zinc-600">
          {rescanCap.count} of {rescanCap.limit} on-demand scans used (24h)
        </span>
      )}
      {!noKeyword && atCap && (
        // Amber-tinted caption pairs visually with the at-cap button, so
        // the "next slot in Xh Ym" reads as one constraint group rather
        // than orphan chrome text below an unrelated button.
        <span
          className="text-[10px] font-mono"
          style={{ color: '#c89545' }}
        >
          next slot {formatNextAvailable(rescanCap?.nextAvailableAt) ?? 'soon'}
        </span>
      )}
      {error && (
        <span className="text-[11px] text-red-400 font-mono max-w-xs text-right">
          {error}
        </span>
      )}
      {/* Full-screen progress overlay during the 30-90s scan +
       *  5-9s NAP audit window. The button's "Scanning territory…"
       *  micro-spinner alone is too quiet — operators see a frozen
       *  page for a minute and start refreshing. The overlay's
       *  rotating phrases reassure them the system is actively
       *  working through each phase (grid → competitor aggregation
       *  → NAP audit → AI Coach). Click-through is blocked while
       *  scanning by the backdrop so a panicked refresh during the
       *  router.refresh() transition can't double-fire. */}
      {isScanning && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(10, 10, 10, 0.92)', backdropFilter: 'blur(4px)' }}
          aria-modal="true"
          role="dialog"
        >
          <ScanProgress className="max-w-md" />
        </div>
      )}
    </div>
  );
}

/** "in 4h 12m" or null when no timestamp. */
function formatNextAvailable(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const ms = t - Date.now();
  if (ms <= 0) return 'now';
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (hours <= 0) return `in ${minutes}m`;
  return `in ${hours}h ${minutes}m`;
}
