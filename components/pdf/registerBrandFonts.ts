/**
 * Register Bricolage Grotesque with @react-pdf/renderer so the PDF
 * exports match the brand spec (CLAUDE.md: "Display font: Bricolage
 * Grotesque").
 *
 * ───────────────────────────────────────────────────────────────────
 * REGISTERED INVARIANT — every PDF template must stay within this:
 *   fontWeight: 400 (regular) or 700 (bold) — nearest-match routing,
 *     but adding 500/600/etc. without registering the corresponding
 *     OTF will route silently to the closer of {400, 700} and may
 *     look subtly off-brand. Audited 2026-06-08: all uses are 400/700.
 *   fontStyle: 'normal' or 'italic' — italic falls back to the
 *     regular cut (synthesized skew), since Bricolage ships no true
 *     italic. Audited 2026-06-08: TurfReport uses zero italics,
 *     RoadmapPdf uses 5 (note callouts + closing block).
 * Adding a new weight/style to a PDF template? Register it here
 * FIRST — otherwise @react-pdf/renderer will throw at render time
 * with "Could not resolve font for Bricolage Grotesque…" (the bug
 * that crashed Justin's regenerate 2026-06-08 on the italic path).
 * ───────────────────────────────────────────────────────────────────
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
  const regularPath = path.join(fontsDir, 'BricolageGrotesque-Regular.otf');
  const boldPath = path.join(fontsDir, 'BricolageGrotesque-Bold.otf');
  // Bricolage Grotesque doesn't ship a true italic cut — the typeface
  // is upright-only. RoadmapPdf.tsx uses `fontStyle: 'italic'` on a
  // handful of body-copy elements (note callouts, promise footer);
  // without an italic registration, @react-pdf/renderer THROWS at
  // render time with "Could not resolve font for Bricolage Grotesque,
  // fontWeight 400, fontStyle italic" — bombing the entire Roadmap
  // PDF generation (caught Yoda / Justin Enns regenerate fails
  // 2026-06-08).
  //
  // Fix: register the regular cut under both 'normal' AND 'italic'
  // styles. @react-pdf/renderer falls back to synthesized italic
  // (visual skew) when the registered file doesn't have native
  // italic outlines — close enough to real italic for emphasis runs
  // and lets the PDF render instead of crash.
  Font.register({
    family: BRAND_FONT_FAMILY,
    fonts: [
      { src: regularPath, fontWeight: 400, fontStyle: 'normal' },
      { src: regularPath, fontWeight: 400, fontStyle: 'italic' },
      { src: boldPath, fontWeight: 700, fontStyle: 'normal' },
      { src: boldPath, fontWeight: 700, fontStyle: 'italic' },
    ],
  });
  // Disable @react-pdf/renderer's hyphenation rules — they're
  // calibrated for English Latin-1 fallback fonts and produce odd
  // breaks (e.g. "TurfMap" → "Turf-Map") with this typeface. Empty
  // array = no hyphenation, words break on whole tokens only.
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}
