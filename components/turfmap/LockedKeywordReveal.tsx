import type { ReactNode } from 'react';
import { Lock, Check, Search } from 'lucide-react';
import type { KeywordCandidateRow } from '@/lib/supabase/types';

/**
 * Locked Keyword Reveal — the free-scan conversion hook on /share.
 *
 * Shows the one keyword we scanned, then the additional service searches a
 * top local competitor ranks for that the buyer isn't tracking — locked,
 * with an unlock CTA. Renders nothing unless there's at least one
 * competitor-ranked candidate.
 *
 * Naming policy: this DELIBERATELY does not name the competitor. The share
 * page masks competitor names server-side for previews (names are part of
 * what the buyer unlocks); naming the rival here would leak that value.
 * The hook is the keyword GAP + count; the "who" is unlock value.
 *
 * Honesty: we did NOT scan the locked keywords, so we don't claim the buyer
 * is invisible on them — only that a competitor competes there and the
 * buyer isn't tracking it yet ("unlock to map your visibility on each").
 */
export function LockedKeywordReveal({
  candidates,
  cta,
}: {
  candidates: KeywordCandidateRow[];
  /** The unlock affordance (the page's existing unlock button). */
  cta?: ReactNode;
}) {
  const scanned = candidates.find((c) => c.status === 'tracked');
  const locked = candidates.filter(
    (c) => c.competitor_ranked && c.status !== 'tracked'
  );
  if (locked.length === 0) return null;

  return (
    <div
      className="border rounded-lg p-5 md:p-6"
      style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-start gap-2.5 mb-1">
        <Search size={18} style={{ color: 'var(--color-lime)' }} className="flex-shrink-0 mt-0.5" />
        <h3 className="font-display text-lg md:text-xl font-bold">
          {locked.length} more search{locked.length === 1 ? '' : 'es'} a competitor is
          winning in your area
        </h3>
      </div>
      <p className="text-xs md:text-sm text-zinc-400 leading-relaxed mb-4 md:ml-7">
        We scanned <span className="text-zinc-200 font-medium">1</span> keyword. Your top
        local competitor also ranks for{' '}
        <span className="text-zinc-200 font-medium">{locked.length}</span> more service
        search{locked.length === 1 ? '' : 'es'}{' '}across your service area — and
        you&rsquo;re only tracking the one. Unlock to map your visibility on each.
      </p>

      <div className="space-y-1.5 md:ml-7">
        {scanned && (
          <div
            className="flex items-center gap-2.5 rounded-md px-3 py-2.5"
            style={{ background: 'rgba(197,255,58,0.06)', border: '1px solid rgba(197,255,58,0.2)' }}
          >
            <Check size={14} strokeWidth={3} style={{ color: 'var(--color-lime)' }} className="flex-shrink-0" />
            <span className="text-sm text-zinc-100 font-medium">{scanned.keyword}</span>
            <span className="ml-auto text-[10px] uppercase tracking-wider font-mono text-zinc-500">
              scanned
            </span>
          </div>
        )}

        {locked.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-2.5 rounded-md px-3 py-2.5"
            style={{ background: '#0b0b0b', border: '1px solid var(--color-border)' }}
          >
            <Lock size={13} className="flex-shrink-0 text-zinc-600" />
            <span className="text-sm text-zinc-300">{c.keyword}</span>
            <span className="ml-auto text-[10px] uppercase tracking-wider font-mono text-zinc-600">
              competitor ranks · not tracked
            </span>
          </div>
        ))}
      </div>

      {cta && <div className="mt-5 md:ml-7">{cta}</div>}
    </div>
  );
}
