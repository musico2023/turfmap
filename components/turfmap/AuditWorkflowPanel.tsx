'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Save,
  FileText,
  Send,
  Check,
  Copy,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { Tier } from '@/lib/supabase/types';

/**
 * Strategist workflow panel for a single audit-tier order.
 *
 * Three actions, gated in order:
 *   1. Save strategist notes (markdown) — required before PDF gen
 *   2. Generate customized PDF (renders TurfReport with notes appended,
 *      uploads to Supabase Storage, returns the public URL)
 *   3. Mark delivered (stamps delivered_at, surfaces the PDF URL for
 *      the operator to copy into a manual email)
 *
 * Phase 1 ships these three actions only. Phase 2 will add: call
 * scheduling fields, competitor screenshot upload (Strategy tier),
 * Resend-based auto-email replacing the manual copy-link step on
 * "Mark delivered."
 *
 * Once delivered_at is set, the panel switches to a read-only state
 * showing the delivery audit trail.
 */
export function AuditWorkflowPanel({
  orderId,
  tier,
  initialNotes,
  deliveryPdfUrl: initialPdfUrl,
  deliveredAt: initialDeliveredAt,
  businessName,
}: {
  orderId: string;
  tier: Tier;
  initialNotes: string;
  deliveryPdfUrl: string | null;
  deliveredAt: string | null;
  businessName: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Notes state — local editor backed by /api/audits/[id]/notes.
  const [notes, setNotes] = useState(initialNotes);
  const [savedNotes, setSavedNotes] = useState(initialNotes);
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesSavedAt, setNotesSavedAt] = useState<number | null>(null);
  const notesDirty = notes !== savedNotes;

  // PDF generation state.
  const [pdfUrl, setPdfUrl] = useState<string | null>(initialPdfUrl);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [pdfGeneratedAt, setPdfGeneratedAt] = useState<number | null>(null);

  // Delivery state.
  const [deliveredAt, setDeliveredAt] = useState<string | null>(
    initialDeliveredAt
  );
  const [deliveringNow, setDeliveringNow] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');

  const isDelivered = deliveredAt != null;
  // Audit ($499) tier needs ~strategist notes minimum to deliver;
  // Strategy ($1,497) needs notes (in Phase 2 will also require
  // competitor-screenshot uploads, but for now notes alone are the
  // gate). Both tiers require generated PDF before delivery.
  const canGeneratePdf = notes.trim().length > 0;
  const canDeliver = pdfUrl != null && !isDelivered;

  const onSaveNotes = async () => {
    setError(null);
    setSavingNotes(true);
    try {
      const res = await fetch(`/api/audits/${orderId}/notes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `save failed (HTTP ${res.status})`);
        return;
      }
      setSavedNotes(notes);
      setNotesSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingNotes(false);
    }
  };

  const onGeneratePdf = async () => {
    setError(null);
    setGeneratingPdf(true);
    try {
      // Save notes first if there are unsaved changes — we don't want
      // to render an out-of-date PDF.
      if (notesDirty) {
        await onSaveNotes();
      }
      const res = await fetch(`/api/audits/${orderId}/generate-pdf`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.url) {
        setError(data.error ?? `PDF generation failed (HTTP ${res.status})`);
        return;
      }
      setPdfUrl(data.url);
      setPdfGeneratedAt(Date.now());
      // Refresh the route so the server-component header reflects the
      // new state (e.g. auto-PDF artifact link, etc.).
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingPdf(false);
    }
  };

  const onMarkDelivered = async () => {
    if (!pdfUrl) return;
    setError(null);
    setDeliveringNow(true);
    try {
      const res = await fetch(`/api/audits/${orderId}/deliver`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as {
        delivered_at?: string;
        error?: string;
      };
      if (!res.ok || !data.delivered_at) {
        setError(data.error ?? `mark-delivered failed (HTTP ${res.status})`);
        return;
      }
      setDeliveredAt(data.delivered_at);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeliveringNow(false);
    }
  };

  const onCopyPdfUrl = async () => {
    if (!pdfUrl) return;
    try {
      await navigator.clipboard.writeText(pdfUrl);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      // ignore — older browsers without clipboard API
    }
  };

  return (
    <div
      className="border rounded-lg p-6"
      style={{
        background: 'var(--color-card)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="mb-5">
        <h2 className="font-display text-lg font-bold mb-1">
          Strategist workflow
        </h2>
        <p className="text-xs text-zinc-500 leading-relaxed max-w-2xl">
          {tier === 'strategy'
            ? 'Strategy Session deliverable: a 60-minute live call, three competitor GBP teardowns, and a comparative report covering all three keyword angles. Phase 1 captures notes + PDF; Phase 2 will layer competitor-screenshot upload + comparative-report editor.'
            : 'Visibility Audit deliverable: a 30-minute live call + strategist diagnosis. Phase 1 captures notes + customized PDF.'}
        </p>
      </div>

      {/* ─── Notes editor ──────────────────────────────────────────── */}
      <section className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <label
            htmlFor="strategist-notes"
            className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold"
          >
            Strategist notes (markdown)
          </label>
          {savedNotes.trim().length > 0 && !notesDirty && (
            <span className="text-[10px] font-mono text-zinc-600">
              {notesSavedAt
                ? `Saved ${formatRelativeTime(notesSavedAt)}`
                : 'Saved'}
            </span>
          )}
          {notesDirty && (
            <span
              className="text-[10px] font-mono"
              style={{ color: '#ff9f3a' }}
            >
              Unsaved changes
            </span>
          )}
        </div>
        <textarea
          id="strategist-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={
            tier === 'strategy'
              ? "Diagnosis from the strategy session…\n\nE.g.\n# Diagnosis\nReach is the binding constraint. Three things are dragging it down:\n1. ...\n\n# Where to focus first\nWeek 1: ...\nWeek 2-3: ...\n\n# Where NOT to spend\n..."
              : "Diagnosis from the clarity session…\n\nE.g.\n# Diagnosis\nThe Apple Maps unverified listing alone is bleeding ~12 cells in the northern half. Highest-leverage fix this month.\n\n# Top three actions, prioritized\n1. ...\n2. ...\n3. ..."
          }
          rows={tier === 'strategy' ? 16 : 12}
          disabled={isDelivered}
          className="w-full px-3 py-2.5 rounded-md border text-sm font-mono leading-relaxed resize-y disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:border-zinc-600 transition-colors"
          style={{
            background: 'var(--color-bg)',
            borderColor: 'var(--color-border)',
            color: '#e4e4e7',
          }}
        />
        <p className="text-[11px] text-zinc-600 mt-1.5">
          Markdown supported. Headers (#, ##), lists (1./- ), bold (**),
          italics (_). Renders into the customized PDF on a new page
          after the AI Coach playbook.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="secondary"
            size="md"
            onClick={onSaveNotes}
            disabled={!notesDirty || savingNotes || isDelivered}
            loading={savingNotes}
            leftIcon={<Save size={12} strokeWidth={2.5} />}
          >
            Save notes
          </Button>
        </div>
      </section>

      {/* ─── Generate PDF ──────────────────────────────────────────── */}
      <section
        className="mb-6 pt-5 border-t"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
            Customized PDF
          </h3>
          {pdfUrl && (
            <span
              className="text-[10px] font-mono"
              style={{ color: 'var(--color-lime)' }}
            >
              {pdfGeneratedAt
                ? `Generated ${formatRelativeTime(pdfGeneratedAt)}`
                : 'Generated'}
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-500 leading-relaxed mb-3 max-w-2xl">
          Renders the buyer&rsquo;s latest scan as a branded PDF and
          appends the strategist notes on a new page after the AI Coach
          playbook. Re-generating overwrites the previous file at the
          same URL — old links keep working.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="md"
            onClick={onGeneratePdf}
            disabled={!canGeneratePdf || generatingPdf || isDelivered}
            loading={generatingPdf}
            loadingLabel="Rendering…"
            leftIcon={<FileText size={12} strokeWidth={2.5} />}
          >
            {pdfUrl ? 'Re-generate PDF' : 'Generate customized PDF'}
          </Button>
          {pdfUrl && (
            <>
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-bold border transition-colors hover:border-zinc-700"
                style={{
                  background: 'var(--color-card)',
                  borderColor: 'var(--color-border)',
                  color: '#e4e4e7',
                }}
              >
                <ExternalLink size={11} /> Open PDF
              </a>
              <Button
                variant="ghost"
                size="md"
                onClick={onCopyPdfUrl}
                leftIcon={
                  copyState === 'copied' ? (
                    <Check
                      size={11}
                      strokeWidth={2.75}
                      style={{ color: 'var(--color-lime)' }}
                    />
                  ) : (
                    <Copy size={11} />
                  )
                }
              >
                {copyState === 'copied' ? 'Copied' : 'Copy URL'}
              </Button>
            </>
          )}
        </div>
        {!canGeneratePdf && (
          <p className="text-[11px] text-zinc-600 mt-2 italic">
            Add strategist notes above to enable PDF generation.
          </p>
        )}
      </section>

      {/* ─── Mark delivered ────────────────────────────────────────── */}
      <section
        className="pt-5 border-t"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-mono font-semibold">
            Delivery
          </h3>
          {isDelivered && (
            <span
              className="text-[10px] font-mono"
              style={{ color: 'var(--color-lime)' }}
            >
              Delivered{' '}
              {deliveredAt
                ? new Date(deliveredAt).toISOString().slice(0, 16).replace('T', ' ')
                : ''}{' '}
              UTC
            </span>
          )}
        </div>
        {isDelivered ? (
          <div className="text-xs text-zinc-400 leading-relaxed">
            This audit is delivered. Buyer was sent the customized PDF
            via manual email. Re-open the PDF link above if the buyer
            asks for a re-send.
          </div>
        ) : (
          <>
            <p className="text-xs text-zinc-500 leading-relaxed mb-3 max-w-2xl">
              Phase 1 manual delivery: copy the PDF URL above and email
              it to{' '}
              <span className="font-mono text-zinc-300">
                {/* Email shown by parent — not duplicated here. */}
                the buyer
              </span>
              {businessName ? (
                <>
                  {' '}({businessName})
                </>
              ) : null}{' '}
              from your own inbox. Click &ldquo;Mark delivered&rdquo; once
              the email is sent. Phase 2 will replace this with a
              one-click Resend-based send.
            </p>
            <Button
              variant="primary"
              size="md"
              onClick={onMarkDelivered}
              disabled={!canDeliver || deliveringNow}
              loading={deliveringNow}
              loadingLabel="Marking delivered…"
              leftIcon={<Send size={12} strokeWidth={2.5} />}
            >
              Mark delivered
            </Button>
            {!canDeliver && (
              <p className="text-[11px] text-zinc-600 mt-2 italic">
                Generate the customized PDF first.
              </p>
            )}
          </>
        )}
      </section>

      {error && (
        <div
          className="mt-5 border rounded-md p-3 text-xs font-mono"
          style={{
            background: '#1a0606',
            borderColor: '#3f0a0a',
            color: '#f87171',
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(timestamp: number): string {
  const ms = Date.now() - timestamp;
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return 'earlier';
}
