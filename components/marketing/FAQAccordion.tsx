'use client';

import { useState } from 'react';
import { Plus, Minus } from 'lucide-react';

export type FAQItem = {
  q: string;
  a: React.ReactNode;
};

/**
 * Single-expand accordion. Clicking an item collapses any other open
 * one — typical FAQ ergonomics. Expanded state lives in component
 * state (no URL hash sync) because deep-linking individual questions
 * isn't valuable on a conversion page.
 */
export function FAQAccordion({ items }: { items: FAQItem[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  return (
    <div className="space-y-2">
      {items.map((item, i) => {
        const open = openIndex === i;
        return (
          <div
            key={i}
            className="border rounded-lg overflow-hidden transition-colors"
            style={{
              background: 'var(--color-card)',
              borderColor: open
                ? 'var(--color-border-bright)'
                : 'var(--color-border)',
            }}
          >
            <button
              type="button"
              onClick={() => setOpenIndex(open ? null : i)}
              className="w-full px-5 py-4 flex items-center justify-between gap-4 text-left transition-colors hover:bg-[var(--color-card-glow)]"
              aria-expanded={open}
            >
              <span className="font-display text-base md:text-lg font-semibold text-zinc-100">
                {item.q}
              </span>
              <span
                className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors"
                style={{
                  background: open
                    ? 'var(--color-lime)'
                    : 'var(--color-bg)',
                  color: open ? 'black' : '#a1a1aa',
                  border: '1px solid var(--color-border)',
                }}
              >
                {open ? <Minus size={13} strokeWidth={3} /> : <Plus size={13} strokeWidth={3} />}
              </span>
            </button>
            {open && (
              <div className="px-5 pb-5 text-sm text-zinc-400 leading-relaxed max-w-3xl">
                {item.a}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
