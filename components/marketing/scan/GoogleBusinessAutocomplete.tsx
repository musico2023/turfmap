'use client';

/**
 * GoogleBusinessAutocomplete — single-input Google Places autocomplete
 * replacement for the lander's businessName + AddressAutocomplete pair.
 *
 * Buyer types business name (or partial), picks from the dropdown,
 * and we resolve the full record (name, address, lat/lng, phone,
 * primary_type, place_id) via /api/places/resolve. The parent form
 * then auto-fills its own state — no separate address field, no
 * separate phone field. 5 fields → 2-3 fields.
 *
 * Uses Google's PlaceAutocompleteElement web component (the GA
 * successor to the legacy Autocomplete widget). It's mounted via
 * the Maps JS API; we load that script on mount with the public
 * NEXT_PUBLIC_GOOGLE_MAPS_API_KEY env var (separate from the
 * server-side GOOGLE_PLACES_API_KEY because the browser needs its
 * own referer-restricted key).
 *
 * Theming approach: the Element exposes a small number of CSS
 * custom properties; we set them in the wrapper to match the
 * dark/lime brand. What can't be themed (e.g. the dropdown row
 * spacing, the Google "powered by" footer) we accept — if Anthony
 * flags visual quality, fall back to a fully custom React combobox
 * (Option B) that talks to the same /api/places/resolve endpoint.
 *
 * Behaviors:
 *   - Loading state until the Maps JS script finishes
 *   - Graceful fallback to a plain `<input>` if the API key isn't
 *     configured (so the form still works, just without autocomplete)
 *   - onResolved fires once per successful pick + resolve
 *   - onClear fires when the buyer empties the input (parent should
 *     wipe its pre-filled state)
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

// Augment the JSX namespace so TS accepts the custom element. The
// real type comes from @googlemaps/types-beta but we don't want to
// pin that as a hard dep just for one element.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'gmp-place-autocomplete': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          // The Element exposes types as attributes — we set them
          // via setAttribute in the effect, not as JSX props, so
          // this is intentionally loose.
          [key: string]: unknown;
        },
        HTMLElement
      >;
    }
  }
  interface Window {
    google?: {
      maps?: {
        importLibrary?: (name: string) => Promise<unknown>;
      };
    };
  }
}

export type ResolvedPlace = {
  placeId: string;
  businessName: string;
  formattedAddress: string;
  latitude: number | null;
  longitude: number | null;
  phone: string;
  primaryType: string | null;
  addressComponents: {
    streetAddress: string | null;
    city: string | null;
    region: string | null;
    postcode: string | null;
    countryCode: string | null;
  } | null;
};

export type GoogleBusinessAutocompleteProps = {
  /** Fired once the picked Place ID has been resolved via
   *  /api/places/resolve. Parent should use this to populate its
   *  businessName / address / lat/lng / phone state in one shot. */
  onResolved: (place: ResolvedPlace) => void;
  /** Fired when the buyer clears the input (input → empty). Parent
   *  should wipe any prior pre-filled state so a stale pick can't
   *  override fresh typing. */
  onClear?: () => void;
  /** Placeholder shown in the autocomplete input. */
  placeholder?: string;
  /** Optional country code bias (ISO 3166-1 alpha-2). When set, the
   *  autocomplete prefers matches in this country. Defaults to 'CA'
   *  since the cold-Meta lead pool skews Canadian; mixed audiences
   *  can omit to get global results. */
  countryCode?: string | null;
  /** Required-state for the parent's form validation. The component
   *  itself can't trigger native HTML5 required behavior on a Web
   *  Component, so the parent gates submit on whether a resolved
   *  place has been set. */
  required?: boolean;
};

const MAPS_LIB_URL = (apiKey: string) =>
  `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
    apiKey
  )}&libraries=places&v=beta&loading=async&callback=__turfmap_gmaps_ready`;

// Singleton flag — guards against double-loading the Maps JS script
// across React re-renders + multiple component mounts on the same
// page. The script itself idempotent-ifies via the `loading=async`
// query param, but we'd still pay a network round-trip per mount
// without this.
let mapsScriptLoading: Promise<void> | null = null;

function loadMapsScript(apiKey: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (mapsScriptLoading) return mapsScriptLoading;
  if (window.google?.maps?.importLibrary) return Promise.resolve();

  mapsScriptLoading = new Promise<void>((resolve, reject) => {
    // Global callback the Maps JS calls back when ready.
    (window as unknown as Record<string, () => void>)[
      '__turfmap_gmaps_ready'
    ] = () => resolve();
    const s = document.createElement('script');
    s.src = MAPS_LIB_URL(apiKey);
    s.async = true;
    s.defer = true;
    s.onerror = () => reject(new Error('Failed to load Google Maps JS'));
    document.head.appendChild(s);
  });
  return mapsScriptLoading;
}

export function GoogleBusinessAutocomplete({
  onResolved,
  onClear,
  placeholder = 'Find your business on Google',
  countryCode = 'CA',
  required = true,
}: GoogleBusinessAutocompleteProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    if (!apiKey) {
      setError('autocomplete unavailable');
      return;
    }
    let cancelled = false;
    void loadMapsScript(apiKey)
      .then(async () => {
        if (cancelled) return;
        // Use the recommended importLibrary path (replaces the
        // legacy direct-access pattern). Returns the constructor.
        const places = (await window.google!.maps!.importLibrary!(
          'places'
        )) as {
          PlaceAutocompleteElement?: new (opts?: {
            includedRegionCodes?: string[];
            requestedRegion?: string;
          }) => HTMLElement;
        };

        if (cancelled) return;
        if (!places.PlaceAutocompleteElement) {
          setError('PlaceAutocompleteElement not available');
          return;
        }
        const el = new places.PlaceAutocompleteElement(
          countryCode ? { includedRegionCodes: [countryCode] } : {}
        );
        // Theming hooks. PlaceAutocompleteElement renders a Shadow
        // DOM; only a small set of CSS variables crosses the boundary.
        // What we can control: width, primary font. Color is mostly
        // baked into Google's internal styles. If Anthony hates the
        // visual, this is the fallback signal: switch to Option B.
        el.style.width = '100%';
        el.setAttribute('placeholder', placeholder);

        // Buyer-pick event. Google has renamed this across API
        // revisions (gmp-placeselect → gmp-select), and the detail
        // shape changed too: the old API delivered a Place object
        // directly; the new API delivers a PlacePrediction that has
        // a placeId getter (and a .toPlace() method for full
        // details). We listen for BOTH event names and check every
        // known property path so we're forward + backward compatible.
        // Also tolerate detail.place.Eg.id which is an internal
        // minified property from older builds — last-ditch fallback.
        const handlePick = (event: Event) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const detail = (event as CustomEvent<any>).detail as any;
          const placeId: string | null =
            // New API: gmp-select fires with placePrediction
            detail?.placePrediction?.placeId ??
            detail?.placePrediction?.place_id ??
            // Legacy API: gmp-placeselect fires with place
            detail?.place?.id ??
            detail?.place?.placeId ??
            // Minified internal property fallback (older builds)
            detail?.place?.Eg?.id ??
            null;
          if (!placeId) {
            console.warn(
              '[business-autocomplete] no place id in event detail',
              detail
            );
            setError(
              "Couldn't read the picked business. Try refreshing or pick another suggestion."
            );
            return;
          }
          setResolving(true);
          setError(null);
          fetch('/api/places/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ place_id: placeId }),
          })
            .then(async (res) => {
              const data = (await res.json()) as ResolvedPlace & {
                ok?: boolean;
                error?: string;
              };
              if (!res.ok || !data.ok) {
                throw new Error(
                  data.error ?? `resolve failed (${res.status})`
                );
              }
              onResolved({
                placeId: data.placeId,
                businessName: data.businessName ?? '',
                formattedAddress: data.formattedAddress ?? '',
                latitude: data.latitude,
                longitude: data.longitude,
                phone: data.phone ?? '',
                primaryType: data.primaryType,
                addressComponents: data.addressComponents,
              });
            })
            .catch((e: unknown) => {
              setError(
                e instanceof Error
                  ? `Couldn't resolve that business: ${e.message}`
                  : 'Failed to resolve business'
              );
            })
            .finally(() => setResolving(false));
        };
        // Listen for both event names — Google fires whichever its
        // current build supports.
        el.addEventListener('gmp-select', handlePick);
        el.addEventListener('gmp-placeselect', handlePick);

        // gmp-error fires on internal failures (invalid API key, no
        // network, etc). Surface so the buyer isn't stuck staring at
        // a broken-feeling field.
        el.addEventListener('gmp-error', () => {
          setError('Autocomplete unavailable. Try refreshing.');
        });

        containerRef.current?.appendChild(el);
        setReady(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(
          e instanceof Error ? e.message : 'Failed to load autocomplete'
        );
      });
    return () => {
      cancelled = true;
      // Detach the element so a remount (e.g. dev mode HMR) doesn't
      // double-render the input.
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, countryCode]);

  // Fallback when env var is missing OR the script failed: render a
  // plain text input so the form is still usable. Parent should
  // handle the "no resolved place" case downstream (i.e. submit
  // gracefully if the buyer typed something without picking).
  if (!apiKey) {
    return (
      <FallbackInput
        placeholder={placeholder}
        required={required}
        onClear={onClear}
      />
    );
  }

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        className="rounded-md border transition-all"
        style={
          {
            background: 'var(--color-bg-input, #0a0a0a)',
            borderColor: 'var(--color-border, #27272a)',
            // The Element ships its own internal padding; we just
            // give it a flush container with the lander's border
            // treatment.
            // CSS variables piped INTO the Element's shadow DOM —
            // the only color knob the Element exposes is the focus
            // ring color, which we map to brand lime.
            '--gmp-mat-color-primary': '#c5ff3a',
          } as CSSProperties
        }
      >
        {!ready && !error && (
          <div className="text-xs text-zinc-500 px-3 py-3">
            Loading business lookup…
          </div>
        )}
      </div>
      {resolving && (
        <div className="text-xs text-zinc-400 flex items-center gap-1.5">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
            style={{ background: 'var(--color-lime, #c5ff3a)' }}
          />
          Resolving from Google…
        </div>
      )}
      {error && (
        <p className="text-xs text-red-400 leading-relaxed" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Render a plain text input when the API key isn't configured so
 *  the lander still functions in environments without GMaps wiring. */
function FallbackInput({
  placeholder,
  required,
  onClear,
}: {
  placeholder: string;
  required: boolean;
  onClear?: () => void;
}) {
  return (
    <input
      type="text"
      className="w-full rounded-md border px-3 py-2.5 text-sm focus:outline-none focus:ring-2 transition-all"
      style={{
        background: 'var(--color-bg-input, #0a0a0a)',
        borderColor: 'var(--color-border, #27272a)',
        color: 'var(--color-text, white)',
      }}
      placeholder={placeholder}
      required={required}
      onChange={(e) => {
        if (e.target.value.trim().length === 0 && onClear) onClear();
      }}
    />
  );
}
