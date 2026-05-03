import type { Metadata } from 'next';
import { Bricolage_Grotesque, Geist, JetBrains_Mono } from 'next/font/google';
import './globals.css';

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
      className={`${bricolage.variable} ${geist.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-[#0a0a0a] text-white font-sans">
        {children}
      </body>
    </html>
  );
}
