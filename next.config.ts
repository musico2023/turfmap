import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  // /scan was previously redirected to / to keep the FOURDOTS50 popup
  // offer URL undiscoverable. As of 2026-05-26, /scan is the cold-Meta
  // paid-traffic lander (MAPCHECK50 + $49 entry point + 1-click audit
  // upsell) — its own page now serves the route. Anyone landing on
  // /scan directly sees the new lander.
  images: {
    // Allow next/image to optimize Anthony's founder headshot served
    // from fourdots.io (used in /scan section 07). Tightly scoped to
    // the proof/ directory of that single host so we're not whitelisting
    // arbitrary fourdots.io paths.
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'fourdots.io',
        pathname: '/assets/proof/**',
      },
    ],
  },
  // Ensure the Bricolage Grotesque TTF that the PDF renderers read
  // via fs.readFileSync (components/pdf/registerBrandFonts.ts) gets
  // bundled into every API route's serverless function. By default,
  // Next.js serves public/ via the static CDN and does NOT include
  // those files in lambda bundles — the fs read would 404 in prod
  // even though it works in `next dev`. This trace include line
  // adds the font file to the function bundle for the PDF-emitting
  // routes (and any future route that imports the renderers).
  outputFileTracingIncludes: {
    '/api/**/*': ['./public/fonts/**/*'],
  },
};

export default nextConfig;
