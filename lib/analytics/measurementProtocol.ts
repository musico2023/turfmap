/**
 * Server-side GA4 events via the Measurement Protocol API.
 *
 * Used to fire events that originate on the server — Stripe webhook
 * payloads, post-purchase fulfillment results, trial conversions —
 * so the GA4 funnel report can attribute conversions to the same
 * sessions/sources that handled the original click. Without this,
 * the trial-canceled and trial-converted events would be invisible
 * to GA4 because the buyer isn't on the page when they fire.
 *
 * The two events that drive the post-purchase funnel:
 *   - trial_canceled_before_day_31  (subscription.deleted while trialing)
 *   - trial_converted_to_paid       (subscription.updated trial→active)
 *
 * GA4 client_id mapping: Stripe's customer id (cus_xxx) is used as
 * the GA client_id anchor. It's deterministic and unique per buyer,
 * so all server-side events fire under a stable id that joins with
 * any client-side events we manually stamp the same id on (the
 * attach-panel events currently auto-generate a client_id from the
 * gtag cookie; if we want the server-side conversions to roll up to
 * the same session, future work should stamp the gtag client_id
 * onto Stripe metadata at attach time).
 *
 * Required env (set in Vercel + .env.local for production):
 *   NEXT_PUBLIC_GA_ID         — already required for client-side gtag
 *   GA_MEASUREMENT_API_SECRET — server-side secret from GA4 Admin →
 *                               Data Streams → Web stream details →
 *                               Measurement Protocol API secrets
 *
 * Never throws. Logs and resolves false on any failure — events
 * are telemetry, not business-critical, and a failed event must
 * never block a user-facing flow.
 */

const ENDPOINT = 'https://www.google-analytics.com/mp/collect';

export type MeasurementProtocolEvent = {
  /** GA4 session-anchor id. Use Stripe customer id (cus_xxx) for
   *  post-purchase events so the buyer's pre/post events join. */
  clientId: string;
  /** GA4 event name. Use snake_case per GA4 conventions. */
  eventName: string;
  /** Flat params attached to the event. Values must be string,
   *  number, or boolean — GA4 rejects nested objects. Currency +
   *  value have special semantics in GA4 (revenue reporting); see
   *  GA4 enhanced-ecommerce docs. */
  params?: Record<string, string | number | boolean | undefined | null>;
};

/**
 * Fire a single GA4 server-side event. Returns a promise that
 * resolves to the success state — callers that care can await,
 * fire-and-forget callers can `.catch()` and move on.
 */
export async function fireMeasurementProtocolEvent(
  event: MeasurementProtocolEvent
): Promise<boolean> {
  const measurementId = process.env.NEXT_PUBLIC_GA_ID;
  const apiSecret = process.env.GA_MEASUREMENT_API_SECRET;

  // Soft-fail when GA isn't fully configured — typical for local dev
  // or when GA_MEASUREMENT_API_SECRET hasn't been provisioned yet.
  // The webhook + API routes still complete; we just lose telemetry.
  if (!measurementId || !apiSecret) {
    return false;
  }

  // GA4 requires non-empty params; default to an empty object then
  // strip null/undefined values that the caller passed through. GA4
  // also caps event_name at 40 chars and param values at 100 chars
  // — we don't truncate here because our events are well under the
  // limits, but be aware of the constraints if expanding.
  const cleanedParams: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(event.params ?? {})) {
    if (v != null) cleanedParams[k] = v;
  }

  const url = `${ENDPOINT}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: event.clientId,
        events: [
          {
            name: event.eventName,
            params: cleanedParams,
          },
        ],
      }),
    });
    // GA4 MP returns 204 No Content on success. Any other status is
    // a soft failure.
    if (!res.ok && res.status !== 204) {
      console.warn(
        `[ga-mp] ${event.eventName} returned HTTP ${res.status}`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[ga-mp] ${event.eventName} failed:`, err);
    return false;
  }
}
