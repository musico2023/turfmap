# TurfMap.ai — Brand Kit

Logo and icon assets for **TurfMap.ai**, the geo-grid rank tracking dashboard
that powers Local Lead Machine. Share this folder as-is with the team.

> TurfMap is proprietary tech by Fourdots Digital. Use these marks only for
> TurfMap / Local Lead Machine materials.

## What's in here

```
brand-kit/
├── logo/
│   ├── turfmap-logo-light-bg.svg   Full lockup, dark wordmark — use on white/light
│   ├── turfmap-logo-light-bg.png   Same, 800×200 raster (transparent background)
│   └── turfmap-logo-dark-bg.svg    Full lockup, white wordmark — use on dark
└── icon/
    ├── turfmap-icon.svg            App mark / favicon — lime square + crosshair
    └── turfmap-icon.png            Same, 512×512 raster (transparent background)
```

**Prefer the SVGs** — they're vector and scale to any size without blur. Use the
PNGs only where SVG isn't supported (some Slack/email/Office contexts).

## Which file when

| Use case | File |
|---|---|
| Light background (docs, white slides, Stripe, email) | `logo/turfmap-logo-light-bg.svg` |
| Dark background (product UI, dark slides, Slack dark mode) | `logo/turfmap-logo-dark-bg.svg` |
| App icon, favicon, social avatar, small spaces | `icon/turfmap-icon.svg` |
| Raster fallback (no SVG support) | the matching `.png` |

## Colors

| Token | Hex | Use |
|---|---|---|
| Brand accent (lime) | `#c5ff3a` | The square, accents, highlights |
| Background | `#0a0a0a` | App background (dark theme) |
| Card | `#0d0d0d` | Surfaces |
| Border | `#27272a` | Hairlines / dividers |
| Wordmark (light bg) | `#0a0a0a` | "TurfMap" text on light |
| Wordmark (dark bg) | `#ffffff` | "TurfMap" text on dark |

## Typography

- **Display / wordmark:** Bricolage Grotesque (Bold / 700)
- **Mono:** JetBrains Mono

The PNG lockups were rendered with a Helvetica fallback for cross-tool
compatibility; the canonical wordmark font is **Bricolage Grotesque Bold**.

## Usage guidelines

- Keep clear space around the logo equal to the height of the lime square.
- Don't recolor, restretch, rotate, or add effects to the mark.
- Don't put the light-bg (dark wordmark) logo on a dark background, or vice
  versa — pick the variant that matches the surface.
- The lime square and crosshair stay the same on every background; only the
  wordmark color changes.
- The icon (lime square + crosshair) is the minimum representation — use it
  when the full wordmark won't fit.

— Fourdots Digital
