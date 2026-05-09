/**
 * /dev/email-preview — index page listing every transactional
 * email template with links into the variant renderer.
 *
 * Internal QA tool. Gated to fourdots-domain emails — even other
 * agency staff don't see it (cuts down on accidental "what's this
 * URL?" Slack pings if anyone screenshares).
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Header } from '@/components/turfmap/Header';
import {
  isAgencyOwnerEmail,
  requireAgencyUserOrRedirect,
} from '@/lib/auth/agency';

export const dynamic = 'force-dynamic';

type TemplateLink = {
  slug: string;
  name: string;
  blurb: string;
  variants: { label: string; query: string }[];
};

const TEMPLATES: TemplateLink[] = [
  {
    slug: 'order-confirmation',
    name: 'Order confirmation',
    blurb:
      'Sent post-Stripe-Checkout for marketing-tripwire buyers. Tier-aware copy + Cal.com booking CTA for Audit/Strategy.',
    variants: [
      { label: 'Pulse', query: 'tier=pulse' },
      { label: 'Pulse+', query: 'tier=pulse_plus' },
      { label: 'TurfScan ($99)', query: 'tier=scan' },
      {
        label: 'Audit ($499) — standalone, with booking',
        query: 'tier=audit&booking=1',
      },
      {
        label: 'Audit ($499) — standalone, no booking URL',
        query: 'tier=audit',
      },
      {
        label: 'Audit upgrade ($197) — auto-scheduled call',
        query: 'tier=audit&kind=upgrade&scheduled=1',
      },
      {
        label: 'Strategy ($1,497) — with booking',
        query: 'tier=strategy&booking=1',
      },
    ],
  },
  {
    slug: 'scan-ready',
    name: 'Scan ready',
    blurb:
      'Sent when first scan completes. Optional metrics block (TurfScore / Reach / Rank).',
    variants: [
      { label: 'With metrics', query: 'metrics=1' },
      { label: 'Without metrics', query: 'metrics=0' },
      { label: 'With PDF attachment', query: 'metrics=1&pdf=1' },
    ],
  },
  {
    slug: 'portal-invite',
    name: 'Portal invite',
    blurb:
      'Magic-link invite sent when an operator adds a portal user to a client.',
    variants: [{ label: 'Default', query: '' }],
  },
  {
    slug: 'pulse-plus-welcome',
    name: 'Pulse+ welcome',
    blurb:
      'Sent after Pulse+ subscription creates. Routes the buyer to citation onboarding.',
    variants: [{ label: 'Default', query: '' }],
  },
  {
    slug: 'stripe-setup-link',
    name: 'Stripe setup link',
    blurb:
      'Sent when an operator creates a Stripe-plan client via /clients/new. Carries Checkout URL.',
    variants: [
      { label: 'Pulse — 14-day trial', query: 'tier=pulse&trial=14' },
      { label: 'Pulse+ — 14-day trial', query: 'tier=pulse_plus&trial=14' },
      { label: 'Pulse+ — 7-day trial', query: 'tier=pulse_plus&trial=7' },
      { label: 'Pulse — no trial', query: 'tier=pulse&trial=0' },
    ],
  },
  {
    slug: 'sign-in-link',
    name: 'Sign-in magic link',
    blurb:
      'Sent when a user requests a fresh sign-in link from /login or /portal/<id>/login. Replaces Supabase\'s default unstyled mailer.',
    variants: [
      { label: 'Agency sign-in', query: '' },
      { label: 'Portal sign-in', query: 'business=1' },
    ],
  },
  {
    slug: 'alert',
    name: 'Post-scan alert',
    blurb:
      'Score-movement / competitor-entry / momentum-reversal / cell-changes alerts dispatched after each scan. All four variants share the new AlertEmail shell.',
    variants: [
      { label: 'Score movement (up)', query: 'kind=score_up' },
      { label: 'Score movement (down)', query: 'kind=score_down' },
      { label: 'New competitors', query: 'kind=competitor_entries' },
      { label: 'Momentum flip (positive)', query: 'kind=momentum_pos' },
      { label: 'Momentum flip (negative)', query: 'kind=momentum_neg' },
      { label: 'Cell changes', query: 'kind=cell_changes' },
    ],
  },
  {
    slug: 'delivery-alert',
    name: 'Operator: scan-delivery alert',
    blurb:
      'Internal cron-fired email listing buyers inside the 24-hour refund window with no completed scan yet.',
    variants: [
      { label: 'Single client', query: 'count=1' },
      { label: 'Multiple clients', query: 'count=4' },
    ],
  },
];

export default async function EmailPreviewIndex() {
  const me = await requireAgencyUserOrRedirect('/dev/email-preview');
  if (!isAgencyOwnerEmail(me.email)) notFound();

  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={me.email} />
      <div className="px-8 py-6 max-w-4xl">
        <h1 className="font-display text-2xl font-bold">Email previews</h1>
        <p className="text-xs text-zinc-500 mt-1 mb-6 max-w-xl">
          Renders every transactional email template with mock data so
          you can review copy + layout without sending real mail. Each
          variant link opens a sandboxed iframe of the rendered HTML.
        </p>

        <div className="space-y-4">
          {TEMPLATES.map((t) => (
            <div
              key={t.slug}
              className="border rounded-lg p-5"
              style={{
                background: 'var(--color-card)',
                borderColor: 'var(--color-border)',
              }}
            >
              <h3 className="font-display text-lg font-bold">{t.name}</h3>
              <p className="text-xs text-zinc-500 mt-0.5 mb-3 leading-relaxed">
                {t.blurb}
              </p>
              <div className="flex flex-wrap gap-2">
                {t.variants.map((v) => (
                  <Link
                    key={v.label}
                    href={`/dev/email-preview/${t.slug}${v.query ? `?${v.query}` : ''}`}
                    className="inline-flex items-center px-3 py-1.5 rounded-md text-xs border transition-colors hover:bg-white/[0.03]"
                    style={{
                      borderColor: 'var(--color-border)',
                      color: '#e4e4e7',
                    }}
                  >
                    {v.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
