import type { MetadataRoute } from 'next';

/**
 * /robots.txt — generated at the edge by Next's MetadataRoute.
 *
 * Canonical host is www (production aliases to www.turfmap.ai; the
 * apex 308-redirects there). All public URLs — sitemap, host hint —
 * use www so Google consolidates signals on one hostname.
 *
 * What we DON'T list here:
 *   - The paid-traffic landers (/fourdots, /freescan, /yourmap) and
 *     /audit-upgrade already carry a `noindex` meta tag. We leave
 *     them OUT of Disallow on purpose: (a) Google must be able to
 *     crawl a page to SEE its noindex directive, and (b) robots.txt
 *     is public — listing /fourdots would advertise the coupon path
 *     we deliberately keep undiscoverable (see the /scan redirect in
 *     next.config.ts).
 *
 * What we DO block: app / auth / API surfaces that should never be
 * crawled at all.
 */

const SITE_URL = 'https://www.turfmap.ai';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/auth/',
          '/login',
          '/clients',
          '/portal',
          '/order',
          '/dev',
          '/share/',
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
