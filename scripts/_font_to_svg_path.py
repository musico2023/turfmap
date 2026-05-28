#!/usr/bin/env python3
"""
Helper for scripts/generate-shorby-banner.mjs.

Reads a TTF + text string + font size and prints a JSON object with:
  - d:      the SVG path 'd' attribute representing the glyph outlines
            of the rendered text (at the requested font size, baseline
            at y=0, starting at x=0)
  - width:  rendered advance width of the string at this font size

Run via: python3 _font_to_svg_path.py <ttf-path> <text> <font-size>
Tracking (letter-spacing) is fixed in CSS-em like opentype.js — pass
the tracking_em argument to override (default: -0.03 em).
"""

import json
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen


def render(font_path: str, text: str, font_size: float, tracking_em: float = -0.03) -> dict:
    font = TTFont(font_path)
    units_per_em = font["head"].unitsPerEm
    scale = font_size / units_per_em
    tracking_units = tracking_em * units_per_em

    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet()
    hmtx = font["hmtx"]

    # Compose path commands across all glyphs, transformed to the
    # requested font size with the y-axis flipped (TTF baseline-up,
    # SVG baseline-down).
    parts = []
    pen_x_units = 0
    for ch in text:
        code = ord(ch)
        glyph_name = cmap.get(code)
        if glyph_name is None:
            # Skip unmapped chars (or use .notdef if present).
            glyph_name = ".notdef" if ".notdef" in glyph_set else None
            if glyph_name is None:
                continue
        advance_units, _ = hmtx[glyph_name]
        glyph = glyph_set[glyph_name]
        pen = SVGPathPen(glyph_set)
        glyph.draw(pen)
        commands = pen.getCommands()
        # Translate to (pen_x_units, 0) in TTF units, then scale to
        # SVG and flip Y. We do this by emitting a transform-wrapping
        # `<g>` per glyph — simpler than re-tokenizing the d string.
        if commands.strip():
            parts.append(
                f'<g transform="matrix({scale} 0 0 {-scale} {pen_x_units * scale} 0)">'
                f'<path d="{commands}"/></g>'
            )
        pen_x_units += advance_units + tracking_units

    total_width_em = pen_x_units * scale
    return {"glyphs_svg": "".join(parts), "width": total_width_em}


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "usage: <ttf> <text> <size> [tracking_em]"}))
        sys.exit(1)
    ttf, text, size = sys.argv[1], sys.argv[2], float(sys.argv[3])
    tracking = float(sys.argv[4]) if len(sys.argv) > 4 else -0.03
    print(json.dumps(render(ttf, text, size, tracking)))


if __name__ == "__main__":
    main()
