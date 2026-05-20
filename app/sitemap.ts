import type { MetadataRoute } from 'next';

/**
 * /sitemap.xml — submitted to Google Search Console.
 *
 * turfmap.ai is primarily the app (clients log in here). The only
 * genuinely public, indexable surface is the marketing homepage —
 * everything else is either an authed app route or a `noindex`
 * paid-traffic lander. The standalone marketing site lives on a
 * separate property (localleadmachine.io) and has its own sitemap.
 *
 * Add a route here only when it's a real public page you WANT in
 * Google's index. Don't add the landers — they're noindex by design.
 */

const SITE_URL = 'https://www.turfmap.ai';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
  ];
}
