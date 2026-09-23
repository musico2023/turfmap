/**
 * Per-IP rate limiting for unauthenticated routes.
 *
 * Extracted verbatim from app/api/prospect/[id]/route.ts, which had the
 * only copy. Generalised because it is also needed on endpoints that
 * spend money per call — /api/places/resolve proxies Google Place
 * Details at $0.017 a request with no auth, so an unbounded caller is a
 * billing amplifier, not just a scraping nuisance.
 *
 * Sliding-window-ish: a Map<key, {count, windowStart}> that resets when
 * the window elapses. Module-level state, so Vercel Fluid Compute keeps
 * it for the instance's lifetime; a new instance starts fresh. Crude,
 * and deliberately so — this is enumeration and cost control, not auth.
 * Cross-instance bypass means hitting several regions, which costs the
 * attacker more than it costs us.
 *
 * Pure apart from the module-level Map and Date.now(); the limiter core
 * is exported separately so it can be tested without wall-clock games.
 * Guarded by scripts/verify-rate-limit.ts.
 */

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  /** Seconds until the caller's window resets. For the Retry-After header. */
  retryAfterSec: number;
};

export type RateLimitOptions = {
  /** Requests permitted per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

type Entry = { count: number; windowStart: number };

/** Independent buckets per caller, so one route's traffic can't exhaust
 *  another's budget. */
const buckets = new Map<string, Map<string, Entry>>();

function bucketFor(name: string): Map<string, Entry> {
  let b = buckets.get(name);
  if (!b) { b = new Map(); buckets.set(name, b); }
  return b;
}

/** Testable core: decide, given the current state, and return the next state. */
export function decide(
  entry: Entry | undefined,
  now: number,
  opts: RateLimitOptions
): { decision: RateLimitDecision; next: Entry } {
  if (!entry || now - entry.windowStart >= opts.windowMs) {
    return {
      decision: { allowed: true, remaining: opts.max - 1, retryAfterSec: 0 },
      next: { count: 1, windowStart: now },
    };
  }
  const elapsed = now - entry.windowStart;
  const retryAfterSec = Math.max(1, Math.ceil((opts.windowMs - elapsed) / 1000));
  if (entry.count >= opts.max) {
    return { decision: { allowed: false, remaining: 0, retryAfterSec }, next: entry };
  }
  const next = { count: entry.count + 1, windowStart: entry.windowStart };
  return {
    decision: { allowed: true, remaining: opts.max - next.count, retryAfterSec },
    next,
  };
}

/** Consume one unit of `key`'s budget in the named bucket. */
export function checkRateLimit(
  bucket: string,
  key: string,
  opts: RateLimitOptions
): RateLimitDecision {
  const b = bucketFor(bucket);
  const { decision, next } = decide(b.get(key), Date.now(), opts);
  b.set(key, next);
  return decision;
}

/** Client IP from Vercel's proxy headers. The first x-forwarded-for entry
 *  is the client; the rest are intermediaries. Falls back to a literal
 *  'unknown' so requests still group sensibly when headers are absent. */
export function clientIpFromRequest(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

/** Test seam — drops all buckets. */
export function __resetRateLimitState(): void {
  buckets.clear();
}
