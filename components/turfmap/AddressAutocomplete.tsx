'use client';

import { useState, useEffect, useRef } from 'react';
import { AddressAutofill } from '@mapbox/search-js-react';

/**
 * TurfMap-matching dark theme for Mapbox suggestion dropdowns.
 *
 * Mapbox's @mapbox/search-js-react ships a light-themed dropdown by
 * default that clashes with our `#0a0a0a` UI. The theme prop accepts
 * a flat `variables` object that's mapped to CSS custom properties
 * inside Mapbox's shadow-DOM dropdown — no global CSS injection,
 * scoped strictly to their suggestion list.
 *
 * Variables align with our existing tokens:
 *   bg / cardBg / border / lime / zinc-100 / zinc-500
 * — so a future TurfMap palette change ripples here naturally if we
 * swap to CSS-variable references in a follow-up.
 */
const TURFMAP_DARK_THEME = {
  variables: {
    colorBackground: '#0d0d0d',
    colorBackgroundHover: '#161616',
    colorBackgroundActive: '#1a2010',
    colorText: '#e4e4e7',
    colorTextWeak: '#a1a1aa',
    colorTextActive: '#c5ff3a',
    colorPrimary: '#c5ff3a',
    border: '1px solid #27272a',
    borderRadius: '6px',
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.6)',
    font: '"Inter", system-ui, -apple-system, sans-serif',
    fontWeight: '500',
    unit: '14px',
    padding: '0.5em',
    spacing: '0.5em',
  },
} as const;

/**
 * Shared address autocomplete component — wraps an input with the
 * Mapbox AddressAutofill dropdown. As the operator types, Mapbox
 * shows suggestions; on selection we fire onSelect with structured
 * fields (street/city/region/postcode/country/lat/lng) so callers
 * can populate downstream form state without a second geocode call.
 *
 * Free-text changes (typing, paste, manual edit) flow through
 * onChange. onSelect only fires when the operator picks a Mapbox
 * suggestion. Callers that need both should listen to both — typed
 * addresses without a selection have no structured-data sidecar.
 *
 * Graceful degradation: when NEXT_PUBLIC_MAPBOX_TOKEN isn't set,
 * renders a plain input with no autocomplete. Local dev without the
 * token still works; the form just falls back to whatever
 * downstream geocoding the API does.
 *
 * Country restriction defaults to US + CA — we serve North American
 * home-services businesses; this dramatically improves suggestion
 * quality and prevents "Toronto, NSW" matches.
 */

export type AddressFields = {
  /** Mapbox's full_address — usually "123 Main St, Toronto, ON M5V 2L7,
   *  Canada". This is what we store in clients.address as the
   *  human-readable canonical form. */
  formatted: string;
  /** Just the street line, e.g. "123 Main St". Mapbox's
   *  address_line1. */
  street_address: string;
  city: string;
  /** State/province. Two-letter code where available — Mapbox returns
   *  "ON" for Ontario, "CA" for California, etc. */
  region: string;
  postcode: string;
  /** ISO 3166-1 alpha-2 country code, lowercase. e.g. "ca", "us". */
  country_code: string;
  latitude: number;
  longitude: number;
};

export type AddressAutocompleteProps = {
  value: string;
  onChange: (next: string) => void;
  onSelect: (fields: AddressFields) => void;
  placeholder?: string;
  required?: boolean;
  /** Tailwind / class names applied to the input element. */
  inputClassName?: string;
  /** Restrict suggestions to these countries (ISO 3166-1 alpha-2,
   *  lowercase). Defaults to ['us', 'ca']. */
  countries?: string[];
  /** Override token from env. Mostly for testing; production reads
   *  process.env.NEXT_PUBLIC_MAPBOX_TOKEN. */
  accessToken?: string;
  /** HTML id for the input — useful for label[for] associations. */
  id?: string;
  /** HTML name for the input. */
  name?: string;
  /** When true, disables the input. */
  disabled?: boolean;
};

// 16px on mobile (text-base) prevents iOS Safari's auto-zoom on
// focus, then drops to 14px (sm:text-sm) at sm+ to match the rest
// of the form's typographic rhythm. Operator-side callers that
// override inputClassName should follow the same pattern.
const DEFAULT_INPUT_CLASS =
  'w-full px-3 py-2 rounded-md border bg-[var(--color-bg)] border-[var(--color-border)] text-base sm:text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

export function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder = '123 Main St, Toronto',
  required,
  inputClassName,
  countries = ['us', 'ca'],
  accessToken,
  id,
  name = 'address',
  disabled,
}: AddressAutocompleteProps) {
  const token = accessToken ?? process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';
  const inputRef = useRef<HTMLInputElement>(null);

  // Mapbox AddressAutofill must be mounted client-side only — it
  // touches `window` during init. Avoid SSR mismatch by deferring
  // the autocomplete tree until after mount; pre-mount we render a
  // plain input so the field doesn't visibly pop in.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const cls = inputClassName ?? DEFAULT_INPUT_CLASS;

  // Fallback path — no token OR not yet mounted. Plain input.
  if (!token || !mounted) {
    return (
      <input
        ref={inputRef}
        id={id}
        name={name}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        autoComplete="address-line1"
        className={cls}
      />
    );
  }

  return (
    <AddressAutofill
      accessToken={token}
      theme={TURFMAP_DARK_THEME}
      options={{
        country: countries.join(','),
        language: 'en',
      }}
      onRetrieve={(res) => {
        const feature = res?.features?.[0];
        if (!feature) return;
        const props = feature.properties ?? {};
        const coords =
          (feature.geometry?.coordinates as [number, number] | undefined) ?? [
            0, 0,
          ];
        const fields: AddressFields = {
          formatted:
            (props.full_address as string | undefined) ??
            (props.place_name as string | undefined) ??
            (props.feature_name as string | undefined) ??
            '',
          street_address:
            (props.address_line1 as string | undefined) ??
            (props.feature_name as string | undefined) ??
            '',
          city: (props.address_level2 as string | undefined) ?? '',
          region: (props.address_level1 as string | undefined) ?? '',
          postcode: (props.postcode as string | undefined) ?? '',
          country_code: (
            (props.country_code as string | undefined) ?? ''
          ).toLowerCase(),
          longitude: Number(coords[0]) || 0,
          latitude: Number(coords[1]) || 0,
        };
        // Sync the freeform field with the canonical formatted address
        // so the input matches what Mapbox just resolved.
        if (fields.formatted) onChange(fields.formatted);
        onSelect(fields);
      }}
    >
      <input
        ref={inputRef}
        id={id}
        name={name}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        autoComplete="address-line1"
        className={cls}
      />
    </AddressAutofill>
  );
}
