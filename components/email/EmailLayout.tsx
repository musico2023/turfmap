/**
 * Shared TurfMap-branded shell for all transactional emails.
 *
 * Why React Email over hand-rolled HTML strings: Gmail/Outlook
 * absolutely require inline styles + nested <table> layout for
 * any non-trivial design — React Email's primitives (Container,
 * Section, Text, Button, etc.) handle all the per-client quirks
 * AND give us a JSX authoring story that scales as we add more
 * templates. Each template imports this layout, fills the body,
 * never thinks about email-client compatibility again.
 *
 * Brand: dark surface (#0a0a0a) with #0d0d0d card, lime accent,
 * Inter (system fallback) for body, 'Bricolage Grotesque' display
 * fallback for the wordmark in the header. Same palette as the
 * dark-themed app — buyers get visual continuity from product →
 * inbox.
 */

import {
  Body,
  Container,
  Head,
  Html,
  Img,
  Preview,
  Section,
  Tailwind,
  Text,
} from '@react-email/components';
import type { ReactNode } from 'react';

export type EmailLayoutProps = {
  /** Used as the email's preview text (the line shown alongside
   *  the subject in inbox lists). Keep < 90 chars. */
  preview: string;
  children: ReactNode;
};

const BG = '#0a0a0a';
const CARD = '#0d0d0d';
const BORDER = '#27272a';
const LIME = '#c5ff3a';
const TEXT = '#e4e4e7';
const TEXT_MUTED = '#a1a1aa';
const TEXT_DIM = '#71717a';

export function EmailLayout({ preview, children }: EmailLayoutProps) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind>
        <Body
          style={{
            backgroundColor: BG,
            color: TEXT,
            fontFamily:
              "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif",
            margin: 0,
            padding: '40px 16px',
          }}
        >
          <Container
            style={{
              maxWidth: 560,
              margin: '0 auto',
              backgroundColor: CARD,
              border: `1px solid ${BORDER}`,
              borderRadius: 8,
              padding: 28,
            }}
          >
            {/* Brand header — crosshair square + wordmark.
                Mirrors the in-app Header component so buyers feel
                visual continuity between the email and the
                dashboard. */}
            <Section style={{ marginBottom: 28 }}>
              <table
                cellPadding={0}
                cellSpacing={0}
                role="presentation"
                style={{ borderCollapse: 'collapse' }}
              >
                <tr>
                  <td style={{ paddingRight: 12, verticalAlign: 'middle' }}>
                    {/* Inline SVG crosshair — same glyph as the in-
                        app Header (lucide Crosshair). Inlined to
                        avoid hosting an image asset. */}
                    <table
                      cellPadding={0}
                      cellSpacing={0}
                      role="presentation"
                      style={{
                        backgroundColor: LIME,
                        borderRadius: 6,
                        width: 36,
                        height: 36,
                      }}
                    >
                      <tr>
                        <td
                          align="center"
                          valign="middle"
                          style={{
                            width: 36,
                            height: 36,
                            textAlign: 'center',
                          }}
                        >
                          <CrosshairGlyph />
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td style={{ verticalAlign: 'middle' }}>
                    <div
                      style={{
                        fontSize: 22,
                        fontWeight: 800,
                        lineHeight: 1,
                        letterSpacing: '-0.01em',
                        color: TEXT,
                      }}
                    >
                      TurfMap
                      <span
                        style={{
                          fontSize: 11,
                          color: LIME,
                          marginLeft: 2,
                          verticalAlign: 'top',
                        }}
                      >
                        ™
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        textTransform: 'uppercase',
                        letterSpacing: '0.18em',
                        color: TEXT_DIM,
                        marginTop: 3,
                      }}
                    >
                      Geo-grid intelligence
                    </div>
                  </td>
                </tr>
              </table>
            </Section>

            {/* Body — each template's content lives here. */}
            <Section>{children}</Section>

            {/* Footer */}
            <Section
              style={{
                borderTop: `1px solid ${BORDER}`,
                marginTop: 32,
                paddingTop: 16,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  color: TEXT_DIM,
                  margin: 0,
                  lineHeight: 1.5,
                }}
              >
                TurfMap™ is proprietary technology of{' '}
                <a
                  href="https://fourdots.io"
                  style={{ color: TEXT_MUTED, textDecoration: 'none' }}
                >
                  Fourdots Digital
                </a>
                . Replies to this email are monitored by the team — hit
                reply with anything you need.
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

/**
 * Inline SVG of lucide's `Crosshair` icon, sized to fit inside
 * the 36×36 brand square. Hardcoded path data so the email
 * doesn't need an image hosted anywhere.
 */
function CrosshairGlyph() {
  return (
    <Img
      src="data:image/svg+xml;utf8,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%2024%2024'%20fill%3D'none'%20stroke%3D'%23000'%20stroke-width%3D'2.75'%20stroke-linecap%3D'round'%20stroke-linejoin%3D'round'%3E%3Ccircle%20cx%3D'12'%20cy%3D'12'%20r%3D'10'%2F%3E%3Cline%20x1%3D'22'%20x2%3D'18'%20y1%3D'12'%20y2%3D'12'%2F%3E%3Cline%20x1%3D'6'%20x2%3D'2'%20y1%3D'12'%20y2%3D'12'%2F%3E%3Cline%20x1%3D'12'%20x2%3D'12'%20y1%3D'6'%20y2%3D'2'%2F%3E%3Cline%20x1%3D'12'%20x2%3D'12'%20y1%3D'22'%20y2%3D'18'%2F%3E%3C%2Fsvg%3E"
      width={20}
      height={20}
      alt=""
      style={{ display: 'inline-block' }}
    />
  );
}

// ─── Reusable building blocks every template can compose ──────────────────

/** Headline — the email's primary statement. Renders large + bold. */
export function H1({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        fontSize: 22,
        fontWeight: 700,
        color: TEXT,
        margin: '0 0 12px',
        lineHeight: 1.2,
      }}
    >
      {children}
    </Text>
  );
}

/** Body paragraph at the standard reading size. */
export function P({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        fontSize: 15,
        color: TEXT,
        margin: '0 0 14px',
        lineHeight: 1.55,
      }}
    >
      {children}
    </Text>
  );
}

/** Smaller, dimmer paragraph — for secondary context like deadlines,
 *  expectations, or fine print. */
export function PSmall({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        fontSize: 13,
        color: TEXT_MUTED,
        margin: '0 0 12px',
        lineHeight: 1.55,
      }}
    >
      {children}
    </Text>
  );
}

/** Primary CTA button — lime fill, black text, dropshadow. Use one
 *  per email, max two. The href is the action target. */
export function PrimaryButton({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <table cellPadding={0} cellSpacing={0} role="presentation" style={{ margin: '20px 0' }}>
      <tr>
        <td>
          <a
            href={href}
            style={{
              display: 'inline-block',
              backgroundColor: LIME,
              color: '#000000',
              fontWeight: 700,
              fontSize: 14,
              padding: '12px 22px',
              borderRadius: 6,
              textDecoration: 'none',
              boxShadow: '0 6px 20px rgba(197,255,58,0.25)',
            }}
          >
            {children}
          </a>
        </td>
      </tr>
    </table>
  );
}

/** Highlight block for surfacing key facts (tier, trial length,
 *  next billing date, etc.). Each entry is a label/value pair. */
export function FactStrip({
  items,
}: {
  items: Array<{ label: string; value: string }>;
}) {
  return (
    <table
      cellPadding={0}
      cellSpacing={0}
      role="presentation"
      width="100%"
      style={{
        backgroundColor: BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 6,
        margin: '16px 0',
      }}
    >
      <tr>
        {items.map((item, i) => (
          <td
            key={item.label}
            style={{
              padding: '12px 16px',
              borderRight:
                i < items.length - 1 ? `1px solid ${BORDER}` : 'none',
              verticalAlign: 'top',
            }}
          >
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.18em',
                color: TEXT_DIM,
                marginBottom: 4,
              }}
            >
              {item.label}
            </div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: TEXT,
                fontFamily:
                  "ui-monospace,SFMono-Regular,'JetBrains Mono',monospace",
              }}
            >
              {item.value}
            </div>
          </td>
        ))}
      </tr>
    </table>
  );
}

/** Tier pill — Pulse / Pulse+ visual badge. Lime for Pulse+,
 *  zinc for Pulse. Used in tier-aware templates so the buyer
 *  sees their plan at a glance. */
export function TierBadge({ tier }: { tier: 'pulse' | 'pulse_plus' }) {
  const isPulsePlus = tier === 'pulse_plus';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '3px 10px',
        backgroundColor: isPulsePlus ? LIME : '#1f1f23',
        color: isPulsePlus ? '#000' : TEXT,
        fontWeight: 700,
        fontSize: 11,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        borderRadius: 4,
        border: isPulsePlus ? 'none' : `1px solid ${BORDER}`,
      }}
    >
      {isPulsePlus ? 'Pulse+' : 'Pulse'}
    </span>
  );
}

/**
 * Subdued inline link for secondary actions in an email — e.g. the
 * "Cancel trial" affordance on the day-28 reminder, where the
 * primary CTA is "Manage subscription" and we don't want the
 * cancel option to compete visually. Renders as light underlined
 * text in the muted color, no padding/background.
 */
export function SecondaryLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      style={{
        color: TEXT_MUTED,
        fontSize: 13,
        textDecoration: 'underline',
      }}
    >
      {children}
    </a>
  );
}

export const COLORS = {
  BG,
  CARD,
  BORDER,
  LIME,
  TEXT,
  TEXT_MUTED,
  TEXT_DIM,
};
