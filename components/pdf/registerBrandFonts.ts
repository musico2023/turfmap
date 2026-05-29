/**
 * Register Bricolage Grotesque with @react-pdf/renderer so the PDF
 * exports match the brand spec (CLAUDE.md: "Display font: Bricolage
 * Grotesque").
 *
 * Why this module exists separately:
 *   Font.register has process-global side effects — once called, the
 *   family is available everywhere in the same Node process. We want
 *   each PDF entrypoint (TurfReport, RoadmapPdf, future templates)
 *   to call registerBrandFonts() once at module load; the
 *   `registered` flag below makes that idempotent so calling from
 *   multiple PDFs in the same process doesn't double-register.
 *
 * Font format / weight strategy:
 *   We register two static OTF instances from the official
 *   Bricolage Grotesque distribution — Regular (wght 400) and Bold
 *   (wght 700). @react-pdf/renderer routes fontWeight values to the
 *   nearest registered weight, so the existing `fontWeight: 700`
 *   style tokens in TurfReport / RoadmapPdf pick up the true Bold
 *   cut rather than synthetic bolding. Total bundle is ~156KB
 *   (smaller than the 408KB variable TTF that lived here previously).
 *
 * Where the OTFs live:
 *   public/fonts/BricolageGrotesque-Regular.otf
 *   public/fonts/BricolageGrotesque-Bold.otf
 *
 *   In a Vercel Fluid Compute deployment, public/ doesn't ship in
 *   the lambda bundle by default — next.config.ts's
 *   outputFileTracingIncludes entry forces those files into the
 *   PDF-generating routes' bundles so the path.join + fs read here
 *   resolves at runtime in both `next dev` and prod.
 */

import { Font } from '@react-pdf/renderer';
import path from 'node:path';

export const BRAND_FONT_FAMILY = 'Bricolage Grotesque';

let registered = false;

export function registerBrandFonts(): void {
  if (registered) return;
  // Resolve from process.cwd() so the path works in both `next dev`
  // (cwd = project root) and Vercel Fluid Compute (cwd = deployment
  // root). Font.register accepts a string path (or URL); the
  // renderer reads the file on demand when laying out glyphs.
  const fontsDir = path.join(process.cwd(), 'public', 'fonts');
  Font.register({
    family: BRAND_FONT_FAMILY,
    fonts: [
      {
        src: path.join(fontsDir, 'BricolageGrotesque-Regular.otf'),
        fontWeight: 400,
      },
      {
        src: path.join(fontsDir, 'BricolageGrotesque-Bold.otf'),
        fontWeight: 700,
      },
    ],
  });
  // Disable @react-pdf/renderer's hyphenation rules — they're
  // calibrated for English Latin-1 fallback fonts and produce odd
  // breaks (e.g. "TurfMap" → "Turf-Map") with this typeface. Empty
  // array = no hyphenation, words break on whole tokens only.
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}
