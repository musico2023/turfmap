/**
 * StuckProspectsAlert — operator-dashboard alert surfacing cold-
 * cohort prospects that the Stage 3 audit-offer cron CAN'T send to.
 *
 * Caught in prod when Apollo Roofing ran a scan + viewed their
 * dashboard, but the cold-stage3 cron silently skipped them because
 * `prospects.email` and `prospects.first_name` were both NULL. The
 * cron's skip path logs to the response payload but doesn't surface
 * anywhere a human reads.
 *
 * This card renders ONLY when there's at least one stuck prospect.
 * Two states per row:
 *
 *   - "Inside window" — engaged within 72h, missing data. Backfill
 *     email/first_name on the prospect row and the next cron tick
 *     (every 15 min) will pick them up.
 *
 *   - "Past 72h" — already missed the cron window. Manual outreach
 *     only — surface so Anthony can pitch the audit personally.
 *
 * Mirrors the gate logic in app/api/cron/cold-stage3/route.ts —
 * keep in sync when those filters change.
 */

import { AlertTriangle, ArrowRight } from 'lucide-react';

const STAGE_3_UPPER_HOURS = 72;

export type StuckProspect = {
  id: string;
  business_name: string;
  trade: string | null;
  city: string | null;
  email: string | null;
  first_name: string | null;
  preview_score: number;
  /** ISO timestamp. */
  scan_engaged_at: string;
};

export type StuckProspectsAlertProps = {
  stuck: StuckProspect[];
};

export function StuckProspectsAlert({ stuck }: StuckProspectsAlertProps) {
  if (stuck.length === 0) return null;

  const now = Date.now();
  const inWindow: StuckProspect[] = [];
  const pastWindow: StuckProspect[] = [];
  for (const p of stuck) {
    const ageHours = (now - new Date(p.scan_engaged_at).getTime()) / 3_600_000;
    if (ageHours <= STAGE_3_UPPER_HOURS) inWindow.push(p);
    else pastWindow.push(p);
  }

  return (
    <div
      className="rounded-lg border p-5 mb-6"
      style={{
        background: '#1f1308',
        borderColor: '#5a2f0a',
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
          style={{
            background: '#3a2208',
            border: '1px solid #5a2f0a',
          }}
        >
          <AlertTriangle
            size={16}
            style={{ color: 'var(--color-warn)' }}
            strokeWidth={2.5}
          />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-display text-base md:text-lg font-bold text-zinc-100 mb-1">
            {stuck.length} cold-cohort{' '}
            {stuck.length === 1 ? 'prospect' : 'prospects'} engaged but Stage 3
            can&rsquo;t send
          </h3>
          <p className="text-xs md:text-sm text-zinc-400 leading-relaxed mb-4">
            They ran a free TurfScan and opened the dashboard, but the cron
            is silently skipping them because{' '}
            <span className="font-mono text-zinc-200">prospects.email</span>{' '}
            or{' '}
            <span className="font-mono text-zinc-200">
              prospects.first_name
            </span>{' '}
            is NULL. Backfill the missing fields and the next 15-min tick
            picks them up — if they&rsquo;re still inside the 72h window.
          </p>

          {inWindow.length > 0 && (
            <StuckList
              label={`${inWindow.length} inside 72h window — backfill now`}
              tone="urgent"
              rows={inWindow}
            />
          )}

          {pastWindow.length > 0 && (
            <StuckList
              label={`${pastWindow.length} past 72h — manual outreach only`}
              tone="stale"
              rows={pastWindow}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function StuckList({
  label,
  tone,
  rows,
}: {
  label: string;
  tone: 'urgent' | 'stale';
  rows: StuckProspect[];
}) {
  const accent = tone === 'urgent' ? 'var(--color-warn)' : '#a4a4a4';
  return (
    <div className="mb-4 last:mb-0">
      <div
        className="text-[10px] uppercase tracking-[0.18em] font-mono font-bold mb-2"
        style={{ color: accent }}
      >
        {label}
      </div>
      <ul className="space-y-1.5">
        {rows.map((p) => {
          const missing: string[] = [];
          if (!p.email) missing.push('email');
          if (!p.first_name) missing.push('first_name');
          const engagedAgeHours = Math.round(
            (Date.now() - new Date(p.scan_engaged_at).getTime()) / 3_600_000
          );
          const ageStr =
            engagedAgeHours >= 24
              ? `${Math.round(engagedAgeHours / 24)}d ago`
              : `${engagedAgeHours}h ago`;
          return (
            <li
              key={p.id}
              className="flex items-start gap-3 text-xs md:text-sm leading-tight py-1.5 px-2.5 rounded"
              style={{ background: '#0a0a0a' }}
            >
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-zinc-100 truncate">
                  {p.business_name}
                </div>
                <div className="text-[11px] text-zinc-500 font-mono mt-0.5 truncate">
                  {p.trade ?? 'unknown trade'}
                  {p.city ? ` · ${p.city}` : ''} · score {p.preview_score} ·
                  engaged {ageStr}
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div
                  className="text-[10px] font-mono uppercase tracking-wider"
                  style={{ color: accent }}
                >
                  missing
                </div>
                <div className="text-[11px] font-mono text-zinc-300 mt-0.5">
                  {missing.join(' + ')}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {tone === 'urgent' && (
        <p className="text-[11px] text-zinc-500 mt-2 leading-relaxed flex items-start gap-1.5">
          <ArrowRight
            size={11}
            strokeWidth={2.5}
            className="mt-0.5 flex-shrink-0"
            style={{ color: accent }}
          />
          <span>
            Backfill via SQL —{' '}
            <code className="font-mono text-zinc-400">
              UPDATE prospects SET email = &lsquo;…&rsquo;, first_name =
              &lsquo;…&rsquo; WHERE id IN (
              {rows
                .slice(0, 3)
                .map((r) => `'${r.id}'`)
                .join(', ')}
              {rows.length > 3 ? ', …' : ''});
            </code>
          </span>
        </p>
      )}
    </div>
  );
}
