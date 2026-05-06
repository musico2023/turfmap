/**
 * /dev/email-preview/[template] — renders a chosen template with
 * mock data inside a sandboxed iframe so the rendered HTML is
 * isolated from the parent page styles. Variants are driven by
 * query params (tier, trial, metrics, pdf, booking).
 *
 * Strategy: render() the React Email tree to an HTML string
 * server-side, then pump it into the iframe via srcDoc. That's
 * the same render pipeline Resend uses, so what you see here is
 * what hits the inbox.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { render } from '@react-email/components';
import { Header } from '@/components/turfmap/Header';
import {
  isAgencyOwnerEmail,
  requireAgencyUserOrRedirect,
} from '@/lib/auth/agency';
import { OrderConfirmationEmail } from '@/components/email/OrderConfirmationEmail';
import { ScanReadyEmail } from '@/components/email/ScanReadyEmail';
import { PortalInviteEmail } from '@/components/email/PortalInviteEmail';
import { PulsePlusWelcomeEmail } from '@/components/email/PulsePlusWelcomeEmail';
import { StripeSetupLinkEmail } from '@/components/email/StripeSetupLinkEmail';
import { calcomBookingUrlForTier } from '@/lib/integrations/calcom';

export const dynamic = 'force-dynamic';

const MOCK_BUSINESS = "Sugar Daddy Doughnuts";
const MOCK_BUYER_EMAIL = 'owner@sugardaddydoughnuts.com';
const MOCK_DASHBOARD_URL = 'https://turfmap.ai/clients/c8da57826c';
const MOCK_CHECKOUT_URL =
  'https://checkout.stripe.com/c/pay/cs_test_a1b2c3d4e5f6g7h8i9j0';
const MOCK_MAGIC_LINK =
  'https://turfmap.ai/auth/callback?token_hash=mock_token_hash_for_preview&type=magiclink';
const MOCK_ONBOARDING_URL =
  'https://turfmap.ai/clients/c8da57826c/citations/setup';

/**
 * Build a Cal.com booking URL for the preview using the real
 * env-configured base URL + the same query-pre-fill helper the
 * production fulfill flow uses. Falls back to a placeholder cal.com
 * URL when the env isn't set so the preview still shows something
 * (rather than null) even pre-launch.
 */
function previewBookingUrlForTier(
  tier: 'audit' | 'strategy'
): string {
  const real = calcomBookingUrlForTier({
    tier,
    email: MOCK_BUYER_EMAIL,
    businessName: MOCK_BUSINESS,
  });
  if (real) return real;
  // Pre-launch placeholder — only used when CAL_COM_*_URL isn't yet
  // set in the local env. Once configured, the helper returns the
  // operator's real Cal slug above.
  return `https://cal.com/turfmap.ai/${tier === 'strategy' ? 'strategy-session' : 'visibility-audit-walkthrough'}?email=${encodeURIComponent(MOCK_BUYER_EMAIL)}&name=${encodeURIComponent(MOCK_BUSINESS)}`;
}

type SearchParams = Record<string, string | string[] | undefined>;

function single(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

async function renderTemplate(
  template: string,
  search: SearchParams
): Promise<{ subject: string; html: string }> {
  switch (template) {
    case 'order-confirmation': {
      const tier = (single(search.tier) ?? 'pulse') as
        | 'scan'
        | 'audit'
        | 'strategy'
        | 'pulse'
        | 'pulse_plus';
      const includeBooking = single(search.booking) === '1';
      const tierLabel = {
        scan: 'TurfScan',
        audit: 'Visibility Audit',
        strategy: 'Strategy Session',
        pulse: 'TurfMap Pulse',
        pulse_plus: 'TurfMap Pulse+',
      }[tier];
      return {
        subject: `Your ${tierLabel} is processing — ${MOCK_BUSINESS}`,
        html: await render(
          OrderConfirmationEmail({
            businessName: MOCK_BUSINESS,
            tier,
            dashboardUrl: MOCK_DASHBOARD_URL,
            bookingUrl:
              includeBooking && (tier === 'audit' || tier === 'strategy')
                ? previewBookingUrlForTier(tier)
                : null,
          })
        ),
      };
    }
    case 'scan-ready': {
      const showMetrics = single(search.metrics) !== '0';
      const hasPdf = single(search.pdf) === '1';
      return {
        subject: `Your TurfMap is ready — ${MOCK_BUSINESS}`,
        html: await render(
          ScanReadyEmail({
            businessName: MOCK_BUSINESS,
            dashboardUrl: MOCK_DASHBOARD_URL,
            metrics: showMetrics
              ? { turfScore: 47, turfReach: 62, turfRank: 2.3 }
              : undefined,
            hasPdfAttachment: hasPdf,
          })
        ),
      };
    }
    case 'portal-invite': {
      return {
        subject: `You've been invited to view ${MOCK_BUSINESS}'s TurfMap`,
        html: await render(
          PortalInviteEmail({
            businessName: MOCK_BUSINESS,
            magicLinkUrl: MOCK_MAGIC_LINK,
          })
        ),
      };
    }
    case 'pulse-plus-welcome': {
      return {
        subject: `Welcome to TurfMap Pulse+ — finish your setup`,
        html: await render(
          PulsePlusWelcomeEmail({
            businessName: MOCK_BUSINESS,
            onboardingUrl: MOCK_ONBOARDING_URL,
          })
        ),
      };
    }
    case 'stripe-setup-link': {
      const tier = (single(search.tier) ?? 'pulse_plus') as 'pulse' | 'pulse_plus';
      const trialRaw = Number(single(search.trial) ?? '14');
      const trialDays = Number.isFinite(trialRaw) ? trialRaw : 14;
      const tierLabel = tier === 'pulse_plus' ? 'TurfMap Pulse+' : 'TurfMap Pulse';
      return {
        subject: `Set up your ${tierLabel} account — ${MOCK_BUSINESS}`,
        html: await render(
          StripeSetupLinkEmail({
            businessName: MOCK_BUSINESS,
            tier,
            trialDays,
            checkoutUrl: MOCK_CHECKOUT_URL,
          })
        ),
      };
    }
    default:
      return { subject: '', html: '' };
  }
}

export default async function EmailPreviewRenderer({
  params,
  searchParams,
}: {
  params: Promise<{ template: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const me = await requireAgencyUserOrRedirect('/dev/email-preview');
  if (!isAgencyOwnerEmail(me.email)) notFound();

  const { template } = await params;
  const search = await searchParams;
  const { subject, html } = await renderTemplate(template, search);
  if (!html) notFound();

  // Build the variant query string we used so the operator can see
  // exactly which mock-data path produced this render.
  const variantParams = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) {
    const single = Array.isArray(v) ? v[0] : v;
    if (single != null) variantParams.set(k, single);
  }
  const variantString = variantParams.toString();

  return (
    <div className="min-h-screen w-full text-white">
      <Header userEmail={me.email} />
      <div className="px-8 py-6 max-w-5xl">
        <Link
          href="/dev/email-preview"
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1 mb-3"
        >
          <ChevronLeft size={12} /> All templates
        </Link>

        <div className="flex items-end justify-between mb-4">
          <div>
            <h1 className="font-display text-2xl font-bold">
              {template
                .split('-')
                .map((s) => s[0].toUpperCase() + s.slice(1))
                .join(' ')}
            </h1>
            <p className="text-xs text-zinc-500 mt-1 font-mono">
              {variantString || '(default variant)'}
            </p>
          </div>
        </div>

        <div
          className="border rounded-lg p-3 mb-3 text-xs"
          style={{
            background: 'var(--color-card)',
            borderColor: 'var(--color-border)',
          }}
        >
          <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
            Subject
          </span>
          <div className="font-mono text-zinc-200 mt-1">{subject}</div>
        </div>

        {/* Sandbox the render in an iframe so the email's body styles
            don't leak into the parent page. srcDoc is the rendered
            HTML string from @react-email/components' render(). */}
        <iframe
          title={`${template} preview`}
          srcDoc={html}
          style={{
            width: '100%',
            minHeight: 800,
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            background: '#0a0a0a',
          }}
          // sandbox attribute restricts the iframe — no scripts or
          // top-navigation. We're rendering trusted content but
          // belt-and-suspenders.
          sandbox="allow-same-origin"
        />
      </div>
    </div>
  );
}
