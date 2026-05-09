/**
 * POST /api/audit/preview-pdf
 *
 * Renders a 90-Day Roadmap PDF from an in-memory payload — no DB
 * lookup, no Supabase Storage upload, no email send. Used by
 * /dev/audit-fixture to preview generated roadmaps without going
 * through the full Phase 3 production-fulfillment pipeline.
 *
 * Body shape:
 *   {
 *     data: RoadmapPdfData  // see components/pdf/RoadmapPdf.tsx
 *   }
 *
 * Returns: application/pdf with a Content-Disposition that suggests
 * a sensible filename based on the buyer business name.
 *
 * Gated to fourdots-domain emails. Same lock as the rest of /api/dev
 * — this endpoint is QA-only and should never be hit from a buyer-
 * facing surface (Phase 3's storage upload + signed URL takes that
 * job in production).
 */

import { NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { z } from 'zod';
import { isAgencyOwnerEmail, requireAgencyUserForApi } from '@/lib/auth/agency';
import {
  RoadmapPdf,
  type RoadmapPdfData,
} from '@/components/pdf/RoadmapPdf';

export const runtime = 'nodejs';
// renderToBuffer is CPU-bound and blocks. 60s is generous for a
// 6-page PDF with no image fetches; 30s would be tight.
export const maxDuration = 60;

// ─── Schema validation ────────────────────────────────────────────────
//
// We validate the incoming payload because it's coming from a client-
// side fetch (the /dev viewer's "Download PDF" button), not from
// trusted server-side code. Loose enough that the AI-generated
// roadmap output passes through; strict enough that a malformed
// request 400s instead of crashing renderToBuffer.

const PdfActionSchema = z.object({
  week: z.number().int().min(1).max(12),
  action: z.string().min(1),
  category: z.enum([
    'review_velocity',
    'directory_claiming',
    'gbp_optimization',
    'gbp_photos',
    'schema_integration',
    'nap_consistency',
    'other',
  ]),
  difficulty: z.enum(['DIY-easy', 'DIY-medium', 'DIY-hard']),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  projectedScoreLift: z.number().int().min(0),
  llmCovered: z.boolean(),
});

const PdfNapFindingSchema = z.object({
  status: z.enum(['MISSING', 'INCONSISTENT', 'LIVE']),
  text: z.string().min(1),
});

const PdfCompetitorSchema = z.object({
  name: z.string().min(1),
  turfScore: z.number().int().min(0).max(100),
  differential: z.string().optional(),
});

const PdfDataSchema = z.object({
  businessName: z.string().min(1),
  trade: z.string().min(1),
  market: z.string().min(1),
  auditDate: z.string().min(1),
  currentTurfScore: z.number().int().min(0).max(100),
  projectedTurfScore: z.number().int().min(0).max(100),
  diagnosis: z.string().min(1),
  actions: z.array(PdfActionSchema).min(1),
  napFindings: z.array(PdfNapFindingSchema),
  competitors: z.array(PdfCompetitorSchema),
  ninetyDayTargetLift: z.number().int().min(0),
});

const RequestBody = z.object({
  data: PdfDataSchema,
});

// ─── Handler ──────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const auth = await requireAgencyUserForApi();
  if (auth instanceof NextResponse) return auth;
  if (!isAgencyOwnerEmail(auth.email)) {
    return NextResponse.json(
      { error: 'preview-pdf is fourdots-only' },
      { status: 403 }
    );
  }

  let parsed: { data: RoadmapPdfData };
  try {
    parsed = RequestBody.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof z.ZodError
          ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : 'invalid request body',
      },
      { status: 400 }
    );
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderToBuffer(<RoadmapPdf data={parsed.data} />);
  } catch (e) {
    console.error('[preview-pdf] renderToBuffer failed', e);
    return NextResponse.json(
      {
        error: `PDF render failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 }
    );
  }

  const safeName = parsed.data.businessName
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
  const filename = `Roadmap-${safeName}-${parsed.data.auditDate.replace(/[^a-zA-Z0-9-]/g, '-')}.pdf`;

  return new Response(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
