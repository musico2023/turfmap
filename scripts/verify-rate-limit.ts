/**
 * Guard for lib/security/rateLimit.ts.
 *
 * The limiter protects /api/places/resolve, which spends $0.017 of Google
 * Places budget per unauthenticated call. The properties that matter:
 * the cap actually stops the (max+1)th request, windows reset, callers and
 * buckets are isolated, and a blocked caller gets a usable Retry-After.
 */
import {
  decide,
  checkRateLimit,
  clientIpFromRequest,
  __resetRateLimitState,
} from '../lib/security/rateLimit';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (!cond) { console.error(`✗ ${name}${detail !== undefined ? `  → ${JSON.stringify(detail)}` : ''}`); failures++; }
  else console.log(`✓ ${name}`);
}

const HOUR = 60 * 60 * 1000;
const opts = { max: 3, windowMs: HOUR };

// ── core decision function, no wall clock ────────────────────────────
let entry = undefined as undefined | { count: number; windowStart: number };
let d = decide(entry, 1_000, opts); entry = d.next;
check('first request allowed', d.decision.allowed && d.decision.remaining === 2);
d = decide(entry, 1_100, opts); entry = d.next;
d = decide(entry, 1_200, opts); entry = d.next;
check('third request allowed, budget exhausted', d.decision.allowed && d.decision.remaining === 0, d.decision);
d = decide(entry, 1_300, opts);
check('fourth request BLOCKED', !d.decision.allowed, d.decision);
check('blocked response carries a positive Retry-After', d.decision.retryAfterSec > 0 && d.decision.retryAfterSec <= 3600, d.decision);
check('blocked request does not extend the window', d.next.windowStart === entry!.windowStart);
check('blocked request does not inflate the count', d.next.count === 3, d.next);

// window reset
d = decide(entry, 1_000 + HOUR, opts);
check('window elapsed → allowed again, counter reset', d.decision.allowed && d.next.count === 1);
d = decide(entry, 1_000 + HOUR - 1, opts);
check('one ms before the window ends → still blocked', !d.decision.allowed);

// ── stateful wrapper: isolation ──────────────────────────────────────
__resetRateLimitState();
for (let i = 0; i < 3; i++) checkRateLimit('places_resolve', '1.2.3.4', opts);
check('4th call from the same IP is blocked', !checkRateLimit('places_resolve', '1.2.3.4', opts).allowed);
check('a different IP is unaffected', checkRateLimit('places_resolve', '5.6.7.8', opts).allowed);
check('a different bucket is unaffected', checkRateLimit('other_route', '1.2.3.4', opts).allowed);

// ── IP extraction ────────────────────────────────────────────────────
const req = (h: Record<string, string>) => new Request('https://x', { headers: h });
check('x-forwarded-for: first entry is the client',
  clientIpFromRequest(req({ 'x-forwarded-for': '203.0.113.9, 70.41.3.18, 150.172.238.178' })) === '203.0.113.9');
check('falls back to x-real-ip', clientIpFromRequest(req({ 'x-real-ip': '198.51.100.7' })) === '198.51.100.7');
check('no headers → "unknown" (still groups)', clientIpFromRequest(req({})) === 'unknown');
check('missing headers all share one bucket, so they stay capped',
  clientIpFromRequest(req({})) === clientIpFromRequest(req({})));

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll rate-limit checks passed.');
