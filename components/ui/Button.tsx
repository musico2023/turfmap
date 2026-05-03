'use client';

import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Activity } from 'lucide-react';
import {
  buttonStyles,
  buttonIconSize,
  SIZE_ICON,
  type ButtonSize,
  type ButtonVariant,
  type ButtonStyleOptions,
} from './buttonStyles';

/**
 * Shared button primitive for TurfMap.
 *
 * Why this exists: pre-refactor every button was hand-crafted (~20
 * call sites with `px-5 py-2.5 rounded-md font-bold ...`). Padding
 * drifted (px-3, px-4, px-5), disabled opacity drifted (40/50/60),
 * icon sizes drifted (11→15), and a primary CTA on the dashboard
 * could look subtly different from a primary CTA on the settings
 * page. This centralizes the design tokens.
 *
 * Five variants — `primary` `secondary` `ai` `ghost` `destructive`.
 * Three sizes — `sm` `md` `lg`. Sizes pick consistent text-, icon-,
 * and padding scales so a md button always looks like a md button.
 *
 * Loading state lives inside the component: pass `loading` and
 * optionally `loadingLabel` and the leading icon swaps to a pulsing
 * Activity glyph and children become the label. No more bespoke
 * busy-state JSX in every form.
 *
 * For `<Link>`-shaped buttons (anchor that looks like a button), use
 * `<LinkButton>` instead — it shares the same styling but renders as
 * a Next.js Link element so navigation, prefetching, and middle-click
 * behavior all work natively.
 *
 * The pure styling helpers (`buttonStyles`, `buttonIconSize`, the
 * `Button{Variant,Size,StyleOptions}` types) live in
 * `./buttonStyles.ts` so server components can call them without
 * crossing the `'use client'` boundary. They're re-exported here for
 * call-site convenience, but server components MUST import them from
 * `./buttonStyles` directly.
 */

export {
  buttonStyles,
  buttonIconSize,
  type ButtonSize,
  type ButtonVariant,
  type ButtonStyleOptions,
};

// ─── <Button> ────────────────────────────────────────────────────────────

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  loading?: boolean;
  /** Optional label shown when `loading` is true. Falls back to
   *  `children` when omitted. */
  loadingLabel?: ReactNode;
};

export function Button({
  variant = 'primary',
  size = 'md',
  leftIcon,
  rightIcon,
  loading = false,
  loadingLabel,
  disabled,
  children,
  className = '',
  style,
  type,
  ...rest
}: ButtonProps) {
  const styles = buttonStyles({ variant, size, className });
  const iconSize = SIZE_ICON[size];
  const renderLeft = loading ? (
    <Activity
      size={iconSize}
      className="animate-pulse flex-shrink-0"
      strokeWidth={2.5}
    />
  ) : leftIcon ? (
    <span className="flex-shrink-0 inline-flex items-center">{leftIcon}</span>
  ) : null;
  return (
    <button
      type={type ?? 'button'}
      disabled={disabled || loading}
      className={styles.className}
      style={{ ...styles.style, ...style }}
      {...rest}
    >
      {renderLeft}
      <span className="inline-flex items-center">
        {loading ? (loadingLabel ?? children) : children}
      </span>
      {!loading && rightIcon && (
        <span className="flex-shrink-0 inline-flex items-center">
          {rightIcon}
        </span>
      )}
    </button>
  );
}

// ─── <LinkButton> ────────────────────────────────────────────────────────

export type LinkButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  href: string;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  children: ReactNode;
  className?: string;
  target?: string;
  rel?: string;
  title?: string;
};

export function LinkButton({
  variant = 'primary',
  size = 'md',
  href,
  leftIcon,
  rightIcon,
  children,
  className = '',
  target,
  rel,
  title,
}: LinkButtonProps) {
  const styles = buttonStyles({ variant, size, className });
  return (
    <Link
      href={href}
      target={target}
      rel={rel}
      title={title}
      className={styles.className}
      style={styles.style}
    >
      {leftIcon && (
        <span className="flex-shrink-0 inline-flex items-center">
          {leftIcon}
        </span>
      )}
      <span className="inline-flex items-center">{children}</span>
      {rightIcon && (
        <span className="flex-shrink-0 inline-flex items-center">
          {rightIcon}
        </span>
      )}
    </Link>
  );
}
