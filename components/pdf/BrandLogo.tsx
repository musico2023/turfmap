/**
 * BrandLogo — TurfMap crosshair-in-lime-square mark, rendered as
 * pure @react-pdf/renderer Svg primitives so it ships inside the
 * PDF binary (no font dependency, no image fetch, no rasterization
 * fallback).
 *
 * Replaces the literal `+` character that earlier PDF templates
 * were using as a placeholder — see CLAUDE.md's brand spec
 * ("Crosshair icon in a lime square + TurfMap.ai wordmark"). The
 * geometry mirrors public/brand/turfmap-icon.svg exactly:
 *   - 96px corner-radius lime square
 *   - black outer ring (donut)
 *   - 4 cardinal tick marks
 *   - implicit center dot (the inner-circle fill leaves it lime)
 *
 * Coordinates are normalized to a 512×512 viewBox so the consumer
 * can size the badge by passing `size` in PDF points; everything
 * scales together.
 */

import { Svg, Rect, Circle, G } from '@react-pdf/renderer';

const LIME = '#c5ff3a';
const BLACK = '#000';

export function BrandLogo({ size = 22 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 512 512">
      {/* Lime rounded square — the badge background. */}
      <Rect x={0} y={0} width={512} height={512} rx={96} ry={96} fill={LIME} />

      {/* Crosshair: black donut + 4 ticks centered at (256, 256). */}
      <G>
        {/* Outer ring built from a filled black circle clipped by a
         *  smaller lime-filled circle. Same trick as the SVG source —
         *  avoids stroke-width quirks in the PDF renderer. */}
        <Circle cx={256} cy={256} r={120} fill={BLACK} />
        <Circle cx={256} cy={256} r={94} fill={LIME} />

        {/* Four cardinal tick marks (top / bottom / left / right). */}
        <Rect x={243} y={138} width={27} height={50} rx={13} ry={13} fill={BLACK} />
        <Rect x={243} y={324} width={27} height={50} rx={13} ry={13} fill={BLACK} />
        <Rect x={138} y={243} width={50} height={27} rx={13} ry={13} fill={BLACK} />
        <Rect x={324} y={243} width={50} height={27} rx={13} ry={13} fill={BLACK} />
      </G>
    </Svg>
  );
}
