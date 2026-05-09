import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  async redirects() {
    return [
      // Legacy paid-traffic LP path. The Fourdots-branded coupon
      // lander used to live at /scan; we moved it to /fourdots so
      // the offer URL is harder to discover via guessing (someone
      // typing turfmap.ai/scan should not bypass the homepage funnel
      // into a discounted checkout). Anyone with a stale popup URL
      // or bookmark gets silently bounced to / where the regular
      // funnel starts. 308 permanent — search engines + clients
      // cache the redirect.
      //
      // Query params drop on this redirect (the homepage doesn't
      // honor coupon=FOURDOTS50 in any way), which is the desired
      // behavior — a stale /scan?coupon=FOURDOTS50 bookmark must
      // NOT reach a discounted page; the user has to click through
      // the popup again to get back into the offer flow.
      {
        source: '/scan',
        destination: '/',
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
