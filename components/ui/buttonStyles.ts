import type { CSSProperties } from 'react';

/**
 * Pure styling helpers for the Button primitive.
 *
 * Lives in its own module (no `'use client'`) so server components can
 * call `buttonStyles({...})` to dress an `<a>` tag in the same visual
 * vocabulary as `<Button>` / `<LinkButton>` without crossing the RSC
 * boundary. (Calling a function exported from a `'use client'` module
 * inside a server component fails at runtime with "Attempted to call X
 * from the server but X is on the client.")
 *
 * The `<Button>` and `<LinkButton>` React components live in
 * `./Button.tsx`, which imports from here.
 */

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ai'
  | 'ghost'
  | 'destructive';

export type ButtonSize = 'sm' | 'md' | 'lg';

export const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1 text-[11px] gap-1.5',
  md: 'px-3 py-2 text-xs gap-1.5',
  lg: 'px-5 py-2.5 text-sm gap-2',
};

export const SIZE_ICON: Record<ButtonSize, number> = { sm: 11, md: 12, lg: 14 };

type VariantSpec = {
  base: string;
  style?: CSSProperties;
};

export const VARIANT: Record<ButtonVariant, VariantSpec> = {
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
