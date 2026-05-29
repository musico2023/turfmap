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
 * Font format choice:
 *   The Google Fonts repo ships Bricolage Grotesque as a single
 *   variable TTF that holds Light → ExtraBold along the wght axis.
 *   @react-pdf/renderer registers a variable TTF as one family + one
 *   "default" weight; when callers ask for fontWeight: 700, the
 *   renderer falls back to synthetic bold (slightly bolder glyph
 *   outline) rather than a true Bold cut. That looks fine in our
 *   PDF dark-mode brand. If we ever need true Bold differentiation,
 *   the path is to download a static Bold instance from
 *   fonts.google.com and register it as a second src here with
 *   { fontWeight: 700 }.
 *
 * Where the TTF lives:
 *   public/fonts/BricolageGrotesque-Variable.ttf (committed to the
 *   repo; ~400KB). In a Vercel Fluid Compute deployment, public/
 *   ships with the function bundle and process.cwd() is the
 *   deployment root, so the fs.readFileSync below resolves at
 *   runtime in both local dev (`next dev`) and prod.
 */

import { Font } from '@react-pdf/renderer';
import path from 'node:path';

export const BRAND_FONT_FAMILY = 'Bricolage Grotesque';

let registered = false;

export function registerBrandFonts(): void {
  if (registered) return;
  // Resolve from process.cwd() so the path works in both `next dev`
  // (cwd = project root) and Vercel Fluid Compute (cwd = deployment
  // root, with public/ shipped alongside the function).
  // Font.register accepts a string path (or URL); the renderer
  // reads the file on demand when laying out glyphs.
  const fontPath = path.join(
    process.cwd(),
    'public',
    'fonts',
    'BricolageGrotesque-Variable.ttf'
  );
  Font.register({
    family: BRAND_FONT_FAMILY,
    src: fontPath,
  });
  // Disable @react-pdf/renderer's hyphenation rules — they're
  // calibrated for English Latin-1 fallback fonts and produce odd
  // breaks (e.g. "TurfMap" → "Turf-Map") with variable-axis
  // typefaces. Empty array = no hyphenation, words break on whole
  // tokens only.
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}
