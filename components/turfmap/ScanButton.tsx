'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Radio, Search } from 'lucide-react';
import { Button } from '@/components/ui/Button';

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
  /** Only the primary keyword is scanned in v1 — passed for the optimistic UI label. */
  keywordLabel?: string;
  /** Server-fetched cap status for THIS location's last 24h of on-demand
   *  scans. Drives the disabled state + the X/N badge under the button.
   *  Optional for back-compat; absence = no rate-limit display. */
  rescanCap?: RescanCap | null;
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
  keywordLabel,
  rescanCap,
}: ScanButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = isScanning || isPending;
  const atCap = rescanCap?.atCap === true;
  const disabled = busy || atCap;

  const onClick = async () => {
    setError(null);
    setIsScanning(true);
    try {
      const res = await fetch('/api/scans/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, locationId: locationId ?? undefined }),
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

  // Variant flips when the rate-limit cap is hit: a primary CTA isn't
  // honest there (clicking would 429); secondary outline reads as
  // "currently unavailable" — same visual language as a disabled nav.
  const label = atCap
    ? 'Daily limit reached'
    : keywordLabel
      ? 'Re-scan turf'
      : 'Run TurfScan';
  const icon = atCap ? (
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
  const atCapStyle = atCap
    ? {
        background: '#1a1308',
        borderColor: '#3a2a0a',
        color: '#f5b651',
      }
    : undefined;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button
        variant={atCap ? 'secondary' : 'primary'}
        size="lg"
        onClick={onClick}
        disabled={disabled}
        loading={busy}
        loadingLabel="Scanning territory…"
        leftIcon={icon}
        style={atCapStyle}
        title={
          atCap
            ? `Daily on-demand scan limit reached (${rescanCap?.count}/${rescanCap?.limit}). Next slot ${formatNextAvailable(rescanCap?.nextAvailableAt) ?? 'soon'}.`
            : undefined
        }
      >
        {label}
      </Button>
      {rescanCap && !atCap && rescanCap.count > 0 && (
        <span className="text-[10px] font-mono text-zinc-600">
          {rescanCap.count} of {rescanCap.limit} on-demand scans used (24h)
        </span>
      )}
      {atCap && (
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
