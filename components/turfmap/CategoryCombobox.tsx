'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

/**
 * Searchable single-select combobox for Google Business Profile
 * categories. Restricting input to a known list prevents BrightLocal
 * citation submissions from failing on typos or non-canonical names.
 */

type Props = {
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  placeholder?: string;
  required?: boolean;
  disabledOptions?: readonly string[];
  inputClassName: string;
};

export function CategoryCombobox({
  value,
  onChange,
  options,
  placeholder,
  required,
  disabledOptions,
  inputClassName,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();

  const disabledSet = useMemo(
    () => new Set(disabledOptions ?? []),
    [disabledOptions]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 100);
    return options.filter((o) => o.toLowerCase().includes(q)).slice(0, 100);
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) {
      setHighlight(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, query]);

  const select = (v: string) => {
    if (disabledSet.has(v)) return;
    onChange(v);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[highlight];
      if (opt) select(opt);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setQuery('');
    }
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`${inputClassName} flex items-center justify-between text-left`}
      >
        <span className={value ? 'text-zinc-100' : 'text-zinc-600'}>
          {value || placeholder || 'Select a category'}
        </span>
        <ChevronDown
          size={14}
          className={`text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {/* Hidden input keeps native required-validation working when the
          form is submitted with no selection. */}
      {required && (
        <input
          tabIndex={-1}
          aria-hidden
          required
          value={value}
          onChange={() => {}}
          className="absolute inset-0 w-full h-full opacity-0 pointer-events-none"
        />
      )}

      {open && (
        <div
          className="absolute z-30 mt-1 w-full rounded-md border shadow-lg overflow-hidden"
          style={{
            background: 'var(--color-card)',
            borderColor: 'var(--color-border)',
          }}
        >
          <div
            className="flex items-center gap-2 px-2.5 py-2 border-b"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <Search size={12} className="text-zinc-500 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search categories…"
              className="w-full bg-transparent text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none"
            />
          </div>
          <ul
            id={listboxId}
            role="listbox"
            className="max-h-64 overflow-y-auto py-1"
          >
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-xs text-zinc-500 font-mono">
                No matches.
              </li>
            )}
            {filtered.map((opt, i) => {
              const isDisabled = disabledSet.has(opt);
              const isSelected = opt === value;
              const isHighlighted = i === highlight;
              return (
                <li
                  key={opt}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={isDisabled}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    select(opt);
                  }}
                  className={`px-3 py-1.5 text-sm flex items-center justify-between gap-2 ${
                    isDisabled
                      ? 'text-zinc-600 cursor-not-allowed'
                      : 'cursor-pointer text-zinc-200'
                  } ${isHighlighted && !isDisabled ? 'bg-zinc-800/60' : ''}`}
                >
                  <span className="truncate">{opt}</span>
                  {isSelected && (
                    <Check size={12} className="text-[var(--color-accent)]" />
                  )}
                  {!isSelected && isDisabled && (
                    <span className="text-[10px] uppercase tracking-wider text-zinc-600 font-mono">
                      added
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
