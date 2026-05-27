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
};

export default nextConfig;
