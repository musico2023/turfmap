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
import { AuditCallReminderEmail } from '@/components/email/AuditCallReminderEmail';
import {
  ScanRecoveryEmail,
  type ScanRecoveryStage,
} from '@/components/email/ScanRecoveryEmail';
import {
  ScoreUnlockNudgeEmail,
  type ScoreUnlockNudgeStage,
} from '@/components/email/ScoreUnlockNudgeEmail';
import { AuditCallConfirmedEmail } from '@/components/email/AuditCallConfirmedEmail';
import { PortalInviteEmail } from '@/components/email/PortalInviteEmail';
import { PulsePlusWelcomeEmail } from '@/components/email/PulsePlusWelcomeEmail';
import { StripeSetupLinkEmail } from '@/components/email/StripeSetupLinkEmail';
import { SignInLinkEmail } from '@/components/email/SignInLinkEmail';
import { AlertEmail } from '@/components/email/AlertEmail';
import { P } from '@/components/email/EmailLayout';
import { DeliveryAlertEmail } from '@/components/email/DeliveryAlertEmail';
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
      const auditPurchaseKind =
        single(search.kind) === 'upgrade' ? 'upgrade' : 'standalone';
      const tierLabel = {
        scan: 'TurfScan',
        audit: 'Visibility Audit',
        strategy: 'Strategy Session',
        pulse: 'TurfMap Pulse',
        pulse_plus: 'TurfMap Pulse+',
      }[tier];
      const subject =
        tier === 'audit'
          ? `Your TurfMap Visibility Audit — what happens next`
          : `Your ${tierLabel} is processing — ${MOCK_BUSINESS}`;
      return {
        subject,
        html: await render(
          OrderConfirmationEmail({
            businessName: MOCK_BUSINESS,
            tier,
            dashboardUrl: MOCK_DASHBOARD_URL,
            bookingUrl:
              includeBooking && (tier === 'audit' || tier === 'strategy')
                ? previewBookingUrlForTier(tier)
                : null,
            auditPurchaseKind,
          })
        ),
      };
    }
    case 'scan-recovery': {
      const stage = (single(search.stage) ?? 'touch_1') as ScanRecoveryStage;
      const sparse = single(search.sparse) === '1';
      const businessName = sparse ? null : MOCK_BUSINESS;
      const keyword = sparse ? null : 'emergency plumber';
      const subjectByStage = {
        touch_1: `You were one step away from your TurfMap — ${businessName ?? 'your business'}`,
        touch_2: `Your competitors are already on the map — ${businessName ?? 'your business'}`,
        touch_3: `Last reminder about your TurfScan — ${businessName ?? 'your business'}`,
      } as const;
      return {
        subject: subjectByStage[stage],
        html: await render(
          ScanRecoveryEmail({
            businessName,
            keyword,
            resumeUrl:
              'https://turfmap.ai/intake?tier=scan&prefill_business=Sugar+Daddy+Doughnuts&prefill_keyword=emergency+plumber&utm_source=cart_recovery&utm_medium=email',
            stage,
          })
        ),
      };
    }
    case 'score-unlock-nudge': {
      const stage = (single(search.stage) ??
        'touch_1') as ScoreUnlockNudgeStage;
      const sparse = single(search.sparse) === '1';
      const businessName = sparse ? null : MOCK_BUSINESS;
      const keyword = sparse ? null : 'emergency plumber';
      const turfScore = sparse ? null : 38;
      const turfBand = sparse ? null : 'Patchy';
      // ?lead_source=free_score|prove_it triggers the Meta-cohort
      // ($49 + MAPCHECK50) price strings; default is the $99 list
      // variant so the preview tab opens to the homepage-/score
      // shape buyers see by default.
      const leadSource = single(search.lead_source) ?? null;
      // Subjects mirror lib/email/resend.ts after the re-gate update.
      // Touch 2 leads on the identity hook; touch 3 calls back to the
      // masked rows. Keep in sync with the dispatcher.
      const subjectByStage = {
        touch_1: `Your TurfScore${turfScore != null ? ` is ${turfScore}/100` : ' is ready'} — ${businessName ?? 'your business'}`,
        touch_2: `Find out who's outranking you — ${businessName ?? 'your business'}`,
        touch_3: `Last call to find out who's outranking you — ${businessName ?? 'your business'}`,
      } as const;
      return {
        subject: subjectByStage[stage],
        html: await render(
          ScoreUnlockNudgeEmail({
            businessName,
            keyword,
            turfScore,
            turfBand,
            previewUrl: 'https://turfmap.ai/share/preview-demo?utm_source=score_drip',
            stage,
            leadSource,
          })
        ),
      };
    }
    case 'audit-call-reminder': {
      return {
        subject: 'One more step: book your TurfMap strategist call',
        html: await render(
          AuditCallReminderEmail({
            businessName: MOCK_BUSINESS,
            bookingUrl: previewBookingUrlForTier('audit'),
          })
        ),
      };
    }
    case 'audit-call-confirmed': {
      const scheduledAt = 'Tuesday, Aug 12 at 2:00 pm EDT';
      return {
        subject: `Strategist call confirmed for ${scheduledAt}`,
        html: await render(
          AuditCallConfirmedEmail({
            businessName: MOCK_BUSINESS,
            scheduledAt,
            manageBookingUrl:
              'https://cal.com/booking/abc123?manage=1',
            dashboardUrl: MOCK_DASHBOARD_URL,
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
    case 'sign-in-link': {
      const isPortal = single(search.business) === '1';
      return {
        subject: isPortal
          ? `Your TurfMap sign-in link — ${MOCK_BUSINESS}`
          : 'Your TurfMap sign-in link',
        html: await render(
          SignInLinkEmail({
            magicLinkUrl: MOCK_MAGIC_LINK,
            businessName: isPortal ? MOCK_BUSINESS : null,
          })
        ),
      };
    }
    case 'alert': {
      const kind = single(search.kind) ?? 'score_down';
      switch (kind) {
        case 'score_up':
          return {
            subject: `↑ TurfScore +14 — ${MOCK_BUSINESS}`,
            html: await render(
              AlertEmail({
                preview: `↑ TurfScore +14 — ${MOCK_BUSINESS}`,
                headline: 'Your TurfScore moved up by 14 points.',
                ctaUrl: MOCK_DASHBOARD_URL,
                ctaLabel: 'Open dashboard →',
                footnote: 'Manage these alerts from your client settings.',
                children: P({
                  children: [
                    <strong key="b">{MOCK_BUSINESS}</strong>,
                    ' moved from ',
                    <span key="p" style={{ color: '#a1a1aa' }}>42</span>,
                    ' to ',
                    <strong key="n" style={{ color: '#c5ff3a' }}>56</strong>,
                    '.',
                  ],
                }),
              })
            ),
          };
        case 'score_down':
          return {
            subject: `↓ TurfScore -8 — ${MOCK_BUSINESS}`,
            html: await render(
              AlertEmail({
                preview: `↓ TurfScore -8 — ${MOCK_BUSINESS}`,
                headline: 'Your TurfScore dropped by 8 points.',
                ctaUrl: MOCK_DASHBOARD_URL,
                ctaLabel: 'Open dashboard →',
                footnote: 'Manage these alerts from your client settings.',
                children: P({
                  children: [
                    <strong key="b">{MOCK_BUSINESS}</strong>,
                    ' moved from ',
                    <span key="p" style={{ color: '#a1a1aa' }}>56</span>,
                    ' to ',
                    <strong key="n" style={{ color: '#ff9f3a' }}>48</strong>,
                    '.',
                  ],
                }),
              })
            ),
          };
        case 'competitor_entries':
          return {
            subject: `New competitors in your 3-pack — ${MOCK_BUSINESS}`,
            html: await render(
              AlertEmail({
                preview: `New competitors in your 3-pack — ${MOCK_BUSINESS}`,
                headline: 'New competitors entered your 3-pack.',
                ctaUrl: MOCK_DASHBOARD_URL,
                ctaLabel: 'Review competitors →',
                footnote: 'Manage these alerts from your client settings.',
                children: (
                  <>
                    {P({ children: `${MOCK_BUSINESS}'s territory has new entrants:` })}
                    <ul style={{ paddingLeft: 18, color: '#e4e4e7', margin: '0 0 8px' }}>
                      <li>Krispy Kreme — Sheppard</li>
                      <li>Tim Hortons (new flagship)</li>
                      <li>Donut House Toronto</li>
                    </ul>
                  </>
                ),
              })
            ),
          };
        case 'momentum_pos':
          return {
            subject: `↗ Momentum turned positive — ${MOCK_BUSINESS}`,
            html: await render(
              AlertEmail({
                preview: `↗ Momentum turned positive — ${MOCK_BUSINESS}`,
                headline: 'Momentum flipped negative → positive.',
                ctaUrl: MOCK_DASHBOARD_URL,
                ctaLabel: 'Open dashboard →',
                footnote: 'Manage these alerts from your client settings.',
                children: P({
                  children: [
                    `${MOCK_BUSINESS}'s momentum is now `,
                    <strong key="m">+9</strong>,
                    '. Whatever you changed last cycle is working — keep going.',
                  ],
                }),
              })
            ),
          };
        case 'momentum_neg':
          return {
            subject: `↘ Momentum turned negative — ${MOCK_BUSINESS}`,
            html: await render(
              AlertEmail({
                preview: `↘ Momentum turned negative — ${MOCK_BUSINESS}`,
                headline: 'Momentum flipped positive → negative.',
                ctaUrl: MOCK_DASHBOARD_URL,
                ctaLabel: 'Open dashboard →',
                footnote: 'Manage these alerts from your client settings.',
                children: P({
                  children: [
                    `${MOCK_BUSINESS}'s momentum is now `,
                    <strong key="m">-7</strong>,
                    '. Worth investigating — competitor activity, GBP edit, or a citation slip.',
                  ],
                }),
              })
            ),
          };
        case 'cell_changes':
          return {
            subject: `12 cells moved — ${MOCK_BUSINESS}`,
            html: await render(
              AlertEmail({
                preview: `12 cells moved — ${MOCK_BUSINESS}`,
                headline: '12 cells changed rank.',
                ctaUrl: MOCK_DASHBOARD_URL,
                ctaLabel: 'See the heatmap →',
                footnote: 'Manage these alerts from your client settings.',
                children: P({
                  children: [
                    `${MOCK_BUSINESS}: `,
                    <strong key="i" style={{ color: '#c5ff3a' }}>8 improved</strong>,
                    ' · ',
                    <strong key="d" style={{ color: '#ff9f3a' }}>4 degraded</strong>,
                    '. Average position improved on average.',
                  ],
                }),
              })
            ),
          };
        default:
          return { subject: '', html: '' };
      }
    }
    // (case 'audit-upgrade-recovery' removed 2026-06-13 — the
    //  audit-upgrade recovery drip itself is gone per Anthony's
    //  page-only upsell policy. The component
    //  components/email/AuditUpgradeRecoveryEmail.tsx was deleted in
    //  the same commit; this preview branch went with it.)
    case 'pulse-recovery': {
      const { PulseRecoveryEmail } = await import(
        '@/components/email/PulseRecoveryEmail'
      );
      const stage =
        (single(search.stage) ?? 'touch_1') as 'touch_1' | 'touch_2';
      const sparse = single(search.sparse) === '1';
      const businessName = sparse ? null : MOCK_BUSINESS;
      const hoursByStage = { touch_1: 24, touch_2: 1 } as const;
      const safeHours = hoursByStage[stage];
      const subjectByStage = {
        touch_1: `60-day Pulse trial (vs the standard 30) — ${businessName ?? 'your business'}`,
        touch_2: `Final ${safeHours}h: your 60-day Pulse trial expires`,
      } as const;
      return {
        subject: subjectByStage[stage],
        html: await render(
          PulseRecoveryEmail({
            businessName,
            reopenUrl:
              'https://turfmap.ai/order/success?tier=scan&session_id=cs_preview&reopen=pulse&extended=1',
            stage,
            hoursRemaining: safeHours,
          })
        ),
      };
    }
    case 'delivery-alert': {
      const count = Number(single(search.count) ?? '4');
      const clients = Array.from({ length: Math.max(1, Math.min(count, 8)) }, (_, i) => ({
        businessName: `Demo Business ${i + 1}`,
        publicId: `demo${i}`,
        hoursSincePurchase: 6 + i * 4,
        billingMode: i % 2 === 0 ? 'self_serve_subscription' : 'one_time',
        buyerEmail: `buyer${i + 1}@example.com`,
        dashboardUrl: `${MOCK_DASHBOARD_URL}-${i}`,
      }));
      return {
        subject: `[TurfMap ops] ${clients.length} client${clients.length === 1 ? '' : 's'} awaiting first scan — refund window`,
        html: await render(DeliveryAlertEmail({ clients })),
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
  // Same env-resilience guard as the index page — see
  // app/dev/email-preview/page.tsx for the rationale.
  let me: { email: string };
  try {
    me = await requireAgencyUserOrRedirect('/dev/email-preview');
  } catch (e) {
    if (e instanceof Error && /SUPABASE_URL|SUPABASE_ANON_KEY/.test(e.message)) {
      return <PreviewUnavailable />;
    }
    throw e;
  }
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

/**
 * Fallback rendered when the dev email preview is hit in an
 * environment where Supabase auth env vars aren't configured. See
 * app/dev/email-preview/page.tsx for the rationale.
 */
function PreviewUnavailable() {
  return (
    <div className="min-h-screen w-full text-white px-8 py-12 max-w-2xl">
      <h1 className="font-display text-xl font-bold mb-3">
        Email preview unavailable.
      </h1>
      <p className="text-sm text-zinc-400 leading-relaxed">
        This dev tool requires Supabase auth env vars
        (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY) to
        gate access. They aren&rsquo;t configured in this environment.
        Use a Production deployment or a local dev server with{' '}
        <code className="font-mono text-zinc-200">.env.local</code>{' '}
        populated to see rendered email templates.
      </p>
    </div>
  );
}
