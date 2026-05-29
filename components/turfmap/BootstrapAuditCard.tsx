'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  ClipboardCheck,
  FileText,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * Agency-side card to manually generate a Visibility Audit Roadmap PDF
 * for a client. Wraps /api/admin/bootstrap-comp-audit in a UI so the
 * operator doesn't need a terminal + curl.
 *
 * Two states:
 *   - hasExistingAudit=false → "Generate" button creates the audit
 *     (lead_orders + visibility_audits rows, Claude → Roadmap PDF →
 *     Supabase Storage, operator email lands in anthony@fourdots.io,
 *     #llm-leads Slack ping fires, NAP audit auto-triggered)
 *   - hasExistingAudit=true → "Regenerate" button re-runs the PDF
 *     generation + re-sends the operator email with the freshest
 *     template / data. Useful after template fixes ship or NAP audit
 *     completes.
 *
 * Optional Cal.com call time input — when filled, stamps
 * strategist_call_scheduled_at so the T-24h pre-call cron picks the
 * row up automatically. Leave blank for pre-booking bootstrap.
 *
 * Visibility: agency-owner-domain emails only (the parent settings
 * page gates rendering via isAgencyOwnerEmail).
 */

export type BootstrapAuditCardProps = {
  /** Client UUID — passed to the admin endpoint as client_id. */
  clientId: string;
  /** Public id used in the agency dashboard link surfaced on success. */
  clientPublicId: string;
  /** Buyer email pre-fill — typically the lead_orders.email from the
   *  original scan or COLDSCAN. The operator can override before submit. */
  defaultEmail: string | null;
  /** Set when a visibility_audits row already exists for this client.
   *  Drives the "Generate" vs "Regenerate" framing + carries the
   *  signed PDF URL for quick download. */
  existingAudit: {
    id: string;
    roadmapPdfUrl: string | null;
    strategistCallScheduledAt: string | null;
  } | null;
};

export function BootstrapAuditCard({
  clientId,
  clientPublicId,
  defaultEmail,
  existingAudit,
}: BootstrapAuditCardProps) {
  const router = useRouter();
  const [email, setEmail] = useState(defaultEmail ?? '');
  // Pre-fill the datetime-local input with the existing scheduled call
  // when present (stripped to minutes for the input's expected format).
  const [callStartTime, setCallStartTime] = useState(
    existingAudit?.strategistCallScheduledAt
      ? toDatetimeLocalValue(existingAudit.strategistCallScheduledAt)
      : ''
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | { kind: 'success'; auditId: string; pdfUrl: string | null; created: boolean }
    | { kind: 'error'; message: string }
    | null
  >(null);

  const isRegenerate = Boolean(existingAudit);

  const submit = async () => {
    setBusy(true);
    setResult(null);
    try {
      const body: Record<string, unknown> = {
        client_id: clientId,
        force_regenerate: isRegenerate,
      };
      if (email.trim()) body.email = email.trim();
      if (callStartTime) {
        // datetime-local gives "2026-06-01T10:00" without timezone.
        // Append Z if no offset present — the admin endpoint validates
        // .datetime() which requires an explicit offset.
        const iso = callStartTime.includes('Z') || /[+-]\d\d:?\d\d$/.test(callStartTime)
          ? callStartTime
          : new Date(callStartTime).toISOString();
        body.call_start_time = iso;
      }
      const res = await fetch('/api/admin/bootstrap-comp-audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        created?: boolean;
        audit_id?: string;
        roadmap_pdf_url?: string | null;
        error?: string;
        stage?: string;
      };
      if (!res.ok || !data.ok) {
        setResult({
          kind: 'error',
          message:
            data.error ??
            `bootstrap failed${data.stage ? ` at ${data.stage}` : ''} (HTTP ${res.status})`,
        });
        return;
      }
      setResult({
        kind: 'success',
        auditId: data.audit_id ?? '',
        pdfUrl: data.roadmap_pdf_url ?? null,
        created: data.created ?? false,
      });
      // Refresh the server data so the card re-renders with
      // existingAudit on next mount (if the operator stays on page).
      router.refresh();
    } catch (e) {
      setResult({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-lg border p-6"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="font-display text-lg font-bold flex items-center gap-2">
            <FileText size={15} style={{ color: 'var(--color-lime)' }} />
            Visibility Audit deliverable
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed max-w-md">
            Operator-only. Generates the 90-Day Roadmap PDF from this
            client&rsquo;s scan + competitor + NAP data, uploads it to
            Storage, emails it to{' '}
            <span className="font-mono text-zinc-400">anthony@fourdots.io</span>,
            and pings <span className="font-mono text-zinc-400">#llm-leads</span>.
            Auto-triggers a fresh NAP audit if one hasn&rsquo;t run yet.
          </p>
        </div>
        {existingAudit && (
          <span
            className="px-2 py-1 rounded text-[10px] uppercase tracking-[0.18em] font-bold whitespace-nowrap"
            style={{
              background: 'rgba(197, 255, 58, 0.1)',
              color: 'var(--color-lime, #c5ff3a)',
              border: '1px solid rgba(197, 255, 58, 0.25)',
            }}
          >
            <ClipboardCheck
              size={10}
              className="inline-block mr-1 -mt-0.5"
            />
            Audit on file
          </span>
        )}
      </div>

      {existingAudit?.roadmapPdfUrl && (
        <div className="mb-4 -mt-1">
          <a
            href={existingAudit.roadmapPdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-zinc-400 hover:text-zinc-200 underline inline-flex items-center gap-1.5"
          >
            <FileText size={11} />
            Open current Roadmap PDF
          </a>
        </div>
      )}

      <div className="space-y-3 mb-4">
        <div>
          <label
            htmlFor="bootstrap-email"
            className="block text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-1"
          >
            Buyer email
          </label>
          <input
            id="bootstrap-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="buyer@example.com"
            className="w-full rounded-md border text-sm text-zinc-100 px-3 py-2 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-lime-400/40"
            style={{
              background: '#0d0d10',
              borderColor: 'var(--color-border)',
            }}
          />
          <p className="text-[10px] text-zinc-600 mt-1">
            Stamped on the comp lead_order so the agency dashboard +
            Slack ping surface the right address.
          </p>
        </div>

        <div>
          <label
            htmlFor="bootstrap-call-time"
            className="block text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold mb-1"
          >
            Cal.com call time (optional)
          </label>
          <input
            id="bootstrap-call-time"
            type="datetime-local"
            value={callStartTime}
            onChange={(e) => setCallStartTime(e.target.value)}
            className="w-full rounded-md border text-sm text-zinc-100 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-lime-400/40"
            style={{
              background: '#0d0d10',
              borderColor: 'var(--color-border)',
            }}
          />
          <p className="text-[10px] text-zinc-600 mt-1">
            When filled, stamps strategist_call_scheduled_at so the
            T-24h pre-call cron picks the row up. Leave blank for
            pre-booking generation.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={busy}
          loading={busy}
          loadingLabel={
            isRegenerate ? 'Regenerating…' : 'Generating…'
          }
          leftIcon={
            isRegenerate ? (
              <RefreshCw size={14} strokeWidth={2.5} />
            ) : (
              <FileText size={14} strokeWidth={2.5} />
            )
          }
        >
          {isRegenerate ? 'Regenerate audit' : 'Generate audit'}
        </Button>
        {existingAudit?.roadmapPdfUrl && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.open(existingAudit.roadmapPdfUrl!, '_blank')}
          >
            Open current PDF
          </Button>
        )}
      </div>

      {result?.kind === 'error' && (
        <div
          className="mt-4 px-3 py-2 rounded-md border text-xs leading-relaxed"
          style={{
            background: '#2a0808',
            borderColor: '#5a1212',
            color: '#fca5a5',
          }}
        >
          {result.message}
        </div>
      )}
      {result?.kind === 'success' && (
        <div
          className="mt-4 px-3 py-2 rounded-md border text-xs leading-relaxed flex items-start gap-2"
          style={{
            background: 'rgba(197, 255, 58, 0.06)',
            borderColor: 'rgba(197, 255, 58, 0.25)',
            color: '#d4d4d8',
          }}
        >
          <CheckCircle2
            size={13}
            strokeWidth={2.25}
            className="flex-shrink-0 mt-0.5"
            style={{ color: 'var(--color-lime)' }}
          />
          <div className="flex-1">
            {result.created ? 'Audit created.' : 'Audit regenerated.'}{' '}
            Roadmap PDF emailed to{' '}
            <span className="font-mono text-zinc-300">
              anthony@fourdots.io
            </span>{' '}
            and{' '}
            <span className="font-mono text-zinc-300">#llm-leads</span>{' '}
            pinged.{' '}
            {result.pdfUrl && (
              <>
                <a
                  href={result.pdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-zinc-200 underline"
                >
                  Open PDF
                </a>
                .
              </>
            )}
          </div>
        </div>
      )}

      <p className="text-[10px] text-zinc-600 mt-3 leading-relaxed">
        Visibility audit URL:{' '}
        <span className="font-mono text-zinc-500">
          /clients/{clientPublicId}
        </span>{' '}
        · Bootstrap source: <span className="font-mono">admin (settings UI)</span>
      </p>
    </div>
  );
}

/** Convert a stored ISO string to the `YYYY-MM-DDTHH:mm` format the
 *  datetime-local input expects. Strips seconds + milliseconds + the
 *  trailing Z so the input renders the value the operator stored. */
function toDatetimeLocalValue(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}
