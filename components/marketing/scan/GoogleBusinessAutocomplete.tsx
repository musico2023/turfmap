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
  useCallback,
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
  /** Fired once when the Google lookup cannot be used at all (script
   *  blocked/stalled, key rejected, element missing).
   *
   *  Parents MUST handle this by switching to their manual-entry path.
   *  Rendering a plain text box here is not enough on its own: the
   *  submit gate keys off a RESOLVED place, which a plain box can never
   *  produce, so the buyer would face a form that looks fillable but a
   *  button that never enables. Observed live on the paid /intake
   *  checkout in the Instagram in-app browser (2026-08). */
  onUnavailable?: () => void;
};

const MAPS_LIB_URL = (apiKey: string) =>
  `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
    apiKey
  )}&libraries=places&v=weekly&loading=async&callback=__turfmap_gmaps_ready`;

/** Hard ceiling on waiting for Google's ready callback. In embedded
 *  in-app browsers (Instagram/Facebook/TikTok WebViews) the script tag can
 *  be blocked or stalled such that NEITHER `onload` nor `onerror` ever
 *  fires — without this the field sits on "Loading business lookup…"
 *  forever and a paid visitor has no idea the manual path exists. */
const MAPS_LOAD_TIMEOUT_MS = 8000;

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
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        // Clear the singleton so a later mount (or a retry) can try
        // again. Leaving a rejected promise cached permanently poisons
        // the lookup for the rest of the page session.
        mapsScriptLoading = null;
        reject(err);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(
      () => finish(new Error('maps-timeout')),
      MAPS_LOAD_TIMEOUT_MS
    );
    // Global callback the Maps JS calls back when ready.
    (window as unknown as Record<string, () => void>)[
      '__turfmap_gmaps_ready'
    ] = () => finish();
    const s = document.createElement('script');
    s.src = MAPS_LIB_URL(apiKey);
    s.async = true;
    s.defer = true;
    s.onerror = () => finish(new Error('maps-script-error'));
    document.head.appendChild(s);
  });
  return mapsScriptLoading;
}

/** True once the Maps JS bootstrap has actually populated the global.
 *  The bootstrap assigns `window.google.maps` on its FIRST line, so if
 *  this is false after our load promise resolved, the script never ran —
 *  the exact state that produced a raw
 *  "undefined is not an object (evaluating 'window.google.maps')"
 *  TypeError on the live /intake checkout (Instagram in-app browser,
 *  2026-08). Checking it lets us fail over to manual entry instead of
 *  dereferencing undefined and printing a JS stack at a paying buyer. */
function mapsGlobalReady(): boolean {
  return typeof window !== 'undefined' && !!window.google?.maps?.importLibrary;
}

export function GoogleBusinessAutocomplete({
  onResolved,
  onClear,
  placeholder = 'Find your business on Google',
  countryCode = 'CA',
  required = true,
  onUnavailable,
}: GoogleBusinessAutocompleteProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Google lookup can't be used at all (script blocked, key rejected,
   *  timed out, element missing). Renders the plain input so checkout
   *  is never blocked — distinct from `error`, which is a recoverable
   *  per-pick failure shown alongside a working widget. */
  const [unavailable, setUnavailable] = useState(false);
  const [resolving, setResolving] = useState(false);

  // Keep the latest callback in a ref so the load effect (which must not
  // re-run when the parent re-renders) always calls the current one.
  const onUnavailableRef = useRef(onUnavailable);
  useEffect(() => {
    onUnavailableRef.current = onUnavailable;
  }, [onUnavailable]);
  /** Single entry point for "Google lookup can't be used": flips to the
   *  plain input AND tells the parent so it can switch to its manual
   *  path (the submit gate needs a resolved place). */
  const markUnavailable = useCallback(() => {
    setUnavailable(true);
    onUnavailableRef.current?.();
  }, []);

  useEffect(() => {
    if (!apiKey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional client-only effect (mount/hydration guard, timer, or external-store sync) — not derivable during render
      markUnavailable();
      return;
    }
    let cancelled = false;
    void loadMapsScript(apiKey)
      .then(async () => {
        if (cancelled) return;
        // Guard BEFORE dereferencing. The load promise resolving does not
        // prove the bootstrap ran (see mapsGlobalReady docstring) — in an
        // in-app WebView it can resolve with the global still undefined,
        // and the old non-null assertions turned that into a raw TypeError
        // rendered on the checkout form.
        if (!mapsGlobalReady()) {
          markUnavailable();
          return;
        }
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
          markUnavailable();
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
        const handlePick = async (event: Event) => {
          // The current GA build of PlaceAutocompleteElement attaches
          // the picked PlacePrediction DIRECTLY to the event (not
          // under event.detail like the legacy CustomEvent pattern).
          // We walk every property path Google has used across
          // revisions so we work regardless of which build the
          // browser loaded.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ev = event as any;
          const targetValue = ev.target?.value as
            | { placeId?: string; place_id?: string; id?: string }
            | undefined;
          const placeId: string | null =
            // Modern: event.placePrediction.placeId
            ev.placePrediction?.placeId ??
            ev.placePrediction?.place_id ??
            // Some builds: the prediction's .toPlace() exposes id
            ev.placePrediction?.toPlace?.()?.id ??
            // Element's .value property (set after pick)
            targetValue?.placeId ??
            targetValue?.place_id ??
            targetValue?.id ??
            // Legacy: detail.placePrediction.placeId
            ev.detail?.placePrediction?.placeId ??
            ev.detail?.place?.id ??
            ev.detail?.place?.placeId ??
            null;
          if (!placeId) {
            // Diagnostic dump — when none of the known paths hit,
            // log the entire event surface so we can converge in
            // one more iteration.
            // eslint-disable-next-line no-console
            console.warn('[business-autocomplete] no place id; dumping event', {
              type: event.type,
              placePrediction: ev.placePrediction,
              target_value: targetValue,
              target_keys: ev.target ? Object.keys(ev.target) : null,
              detail: ev.detail,
              event_keys: Object.keys(ev).filter((k) => !k.startsWith('_')),
            });
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
          // Invalid key / no network / Google-side fault. Swap to the
          // plain input rather than leaving a dead widget on the form.
          markUnavailable();
        });

        containerRef.current?.appendChild(el);
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        // NEVER surface the raw error text here. This runs on the paid
        // /intake checkout; the previous behaviour printed the underlying
        // JS message ("undefined is not an object (evaluating
        // 'window.google.maps')") directly above the price. Fail over to
        // the plain input — the buyer can still complete the purchase.
        markUnavailable();
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
  // Key missing, or the Google lookup failed to initialise for any
  // reason. Either way the buyer gets a working text field instead of a
  // dead widget or a JS error — the parent already supports the
  // "typed but not picked" path via manual entry.
  if (!apiKey || unavailable) {
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
