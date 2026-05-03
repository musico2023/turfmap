'use client';

import Link from 'next/link';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { Activity } from 'lucide-react';

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
 */

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ai'
  | 'ghost'
  | 'destructive';

export type ButtonSize = 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1 text-[11px] gap-1.5',
  md: 'px-3 py-2 text-xs gap-1.5',
  lg: 'px-5 py-2.5 text-sm gap-2',
};

const SIZE_ICON: Record<ButtonSize, number> = { sm: 11, md: 12, lg: 14 };

type VariantSpec = {
  base: string;
  style?: CSSProperties;
};

const VARIANT: Record<ButtonVariant, VariantSpec> = {
  primary: {
    base: [
      'rounded-md font-bold flex items-center justify-center transition-all whitespace-nowrap',
      'hover:brightness-110',
      'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100',
    ].join(' '),
    style: {
      background: 'var(--color-lime)',
      color: 'black',
      boxShadow: '0 4px 16px #c5ff3a30',
    },
  },
  secondary: {
    base: [
      'rounded-md font-bold border flex items-center transition-colors whitespace-nowrap',
      'hover:border-zinc-700',
      'disabled:opacity-50 disabled:cursor-not-allowed',
    ].join(' '),
    style: {
      background: 'var(--color-card)',
      borderColor: 'var(--color-border)',
      color: '#e4e4e7',
    },
  },
  ai: {
    base: [
      'rounded-md font-bold border flex items-center transition-all whitespace-nowrap',
      'hover:brightness-110',
      'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100',
    ].join(' '),
    style: {
      background: '#0a0f04',
      color: 'var(--color-lime)',
      borderColor: 'var(--color-border-bright)',
    },
  },
  ghost: {
    base: [
      'rounded-md font-mono flex items-center transition-colors whitespace-nowrap',
      'text-zinc-500 hover:text-zinc-300',
      'disabled:opacity-50 disabled:cursor-not-allowed',
    ].join(' '),
  },
  destructive: {
    base: [
      'rounded-md font-bold border flex items-center transition-colors whitespace-nowrap',
      'text-zinc-400 hover:text-red-400 hover:border-red-900',
      'disabled:opacity-50 disabled:cursor-not-allowed',
    ].join(' '),
    style: {
      background: 'var(--color-card)',
      borderColor: 'var(--color-border)',
    },
  },
};

export type ButtonStyleOptions = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
};

/**
 * Compute the className + inline style pair for a given variant+size.
 * Useful when a `<Link>` or other non-button element needs the visual
 * styling without wrapping it in `<Button>`. Prefer `<LinkButton>`
 * for navigation-style buttons.
 */
export function buttonStyles({
  variant = 'primary',
  size = 'md',
  className = '',
}: ButtonStyleOptions): { className: string; style: CSSProperties } {
  const v = VARIANT[variant];
  const composed = `${v.base} ${SIZE_CLASSES[size]} ${className}`.trim();
  return { className: composed, style: v.style ?? {} };
}

export function buttonIconSize(size: ButtonSize = 'md'): number {
  return SIZE_ICON[size];
}

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
