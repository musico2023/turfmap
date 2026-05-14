import type { Metadata } from 'next';
import { Bricolage_Grotesque, Geist, JetBrains_Mono } from 'next/font/google';
import Script from 'next/script';
import { GoogleAnalytics } from '@next/third-parties/google';
import { Analytics as VercelAnalytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import './globals.css';

// Analytics IDs — public identifiers (they end up in the loaded
// script URLs anyway). Hardcoded with env-var overrides so per-env
// setups (e.g. a dev property to keep prod numbers clean) just need
// NEXT_PUBLIC_GA_ID / NEXT_PUBLIC_CLARITY_ID set; an empty string
// disables that surface entirely.
const GA_MEASUREMENT_ID =
  process.env.NEXT_PUBLIC_GA_ID ?? 'G-EQQQ82CS13';
const CLARITY_PROJECT_ID =
  process.env.NEXT_PUBLIC_CLARITY_ID ?? 'wo1co02xpl';

// Display headings — used by the .font-display utility.
const bricolage = Bricolage_Grotesque({
  variable: '--font-display',
  subsets: ['latin'],
  display: 'swap',
});

// Body sans (matches the prototype's Geist + system fallback).
const geist = Geist({
  variable: '--font-sans',
  subsets: ['latin'],
  display: 'swap',
});

// Tech / data labels — used by the .font-mono utility.
const jetbrainsMono = JetBrains_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'TurfMap.ai — Geo-grid intelligence',
  description:
    'Geo-grid rank tracking + AI-driven local SEO playbooks for local-service and healthcare businesses. Built by Fourdots Digital.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${bricolage.variable} ${geist.variable} ${jetbrainsMono.variable} h-full antialiased scroll-smooth`}
    >
      <body className="min-h-full bg-[#0a0a0a] text-white font-sans">
        {children}
        {/* Vercel Analytics — auto-tracks page views + conversion
         *  metrics inside the Vercel dashboard. Privacy-friendly
         *  (no PII, no consent banner needed in EU). Lives inside
         *  <body> per Vercel's docs so the script tag is rendered
         *  in the right place; the App Router integration handles
         *  client-side route changes automatically. */}
        <VercelAnalytics />
        {/* Vercel Speed Insights — real-user Core Web Vitals
         *  (LCP / CLS / INP) per route. Free on Pro; informs the
         *  Web Vitals → Google ranking signal we care about for a
         *  local-SEO product. */}
        <SpeedInsights />
      </body>
      {/* Google Analytics 4. The component handles App Router
       *  client-side route changes automatically — pageviews fire on
       *  every route swap, not just full reloads. Skipped when GA_ID
       *  is empty (e.g. local dev with NEXT_PUBLIC_GA_ID="") so
       *  development sessions don't pollute prod metrics. */}
      {GA_MEASUREMENT_ID && <GoogleAnalytics gaId={GA_MEASUREMENT_ID} />}
      {/* Microsoft Clarity — heatmaps + session recordings. Loaded
       *  with strategy="afterInteractive" so it doesn't block the
       *  initial paint; the IIFE matches Clarity's recommended
       *  install snippet exactly (loader pushes to clarity.q before
       *  the tag finishes loading, then drains the queue). */}
      {CLARITY_PROJECT_ID && (
        <Script
          id="ms-clarity"
          strategy="afterInteractive"
        >{`(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window, document, "clarity", "script", "${CLARITY_PROJECT_ID}");`}</Script>
      )}
    </html>
  );
}
