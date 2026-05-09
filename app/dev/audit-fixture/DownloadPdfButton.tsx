'use client';

/**
 * Client island for the "Download PDF" button on /dev/audit-fixture.
 *
 * Takes the in-memory fixture payload, transforms it into the shape
 * RoadmapPdf expects, POSTs to /api/audit/preview-pdf, and triggers
 * a download of the returned PDF blob. No state shared across page
 * loads — the parent server component re-fetches the fixture each
 * render and passes a fresh prop in.
 */

import { useState } from 'react';
import type { ActionCategory, ActionPriority, DifficultyRating } from '@/lib/supabase/types';

// Mirror of components/pdf/RoadmapPdf.tsx's RoadmapPdfData. We don't
// import the PDF type here because @react-pdf/renderer is Node-only
// — pulling its type tree into a client bundle would balloon it.
type PdfPayload = {
  businessName: string;
  trade: string;
  market: string;
  auditDate: string;
  currentTurfScore: number;
  projectedTurfScore: number;
  diagnosis: string;
  actions: Array<{
    week: number;
    action: string;
    category: ActionCategory;
    difficulty: DifficultyRating;
    priority: ActionPriority;
    projectedScoreLift: number;
    llmCovered: boolean;
  }>;
  napFindings: Array<{
    status: 'MISSING' | 'INCONSISTENT' | 'LIVE';
    text: string;
  }>;
  competitors: Array<{
    name: string;
    turfScore: number;
    differential?: string;
  }>;
  ninetyDayTargetLift: number;
};

export function DownloadPdfButton({ payload }: { payload: PdfPayload }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/audit/preview-pdf', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: payload }),
      });
      if (!res.ok) {
        const errorBody = await res.text();
        throw new Error(`${res.status}: ${errorBody}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      // Anchor + click + revoke is the canonical "save the blob" idiom.
      // We could also window.open(url) for inline view, but a real
      // download trains the QA flow on what the production buyer
      // experience looks like (PDF lands in their downloads folder).
      const a = document.createElement('a');
      a.href = url;
      const safeName = payload.businessName.replace(/[^a-zA-Z0-9]/g, '-');
      a.download = `Roadmap-${safeName}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-semibold transition-colors disabled:opacity-50"
        style={{
          background: 'var(--color-lime)',
          color: '#000',
        }}
      >
        {busy ? 'Rendering PDF…' : 'Download Roadmap PDF'}
      </button>
      {error ? (
        <span className="text-xs text-red-400 font-mono">{error}</span>
      ) : null}
    </div>
  );
}
