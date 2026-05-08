import type { Metadata } from 'next';
import { Bricolage_Grotesque, Geist, JetBrains_Mono } from 'next/font/google';
import { GoogleAnalytics } from '@next/third-parties/google';
import './globals.css';

// Google Analytics 4 measurement ID. Hardcoded because it's a public
// identifier (it ends up in the gtag.js URL anyway) and the marketing
// site is the only property pointing at this ID. To override per
// environment (e.g. a dev property to keep prod numbers clean), set
// NEXT_PUBLIC_GA_ID — empty string disables GA entirely.
const GA_MEASUREMENT_ID =
  process.env.NEXT_PUBLIC_GA_ID ?? 'G-EQQQ82CS13';

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
      </body>
      {/* Google Analytics 4. The component handles App Router
       *  client-side route changes automatically — pageviews fire on
       *  every route swap, not just full reloads. Skipped when GA_ID
       *  is empty (e.g. local dev with NEXT_PUBLIC_GA_ID="") so
       *  development sessions don't pollute prod metrics. */}
      {GA_MEASUREMENT_ID && <GoogleAnalytics gaId={GA_MEASUREMENT_ID} />}
    </html>
  );
}
