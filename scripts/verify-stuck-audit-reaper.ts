/**
 * Guard: stuck NAP-audit reap decisions.
 *
 * Context (2026-09-03): 35 nap_audits rows were stranded at 'pending' —
 * all trigger_source='scan', none with an error_message, oldest 71 days,
 * 3 belonging to one_time buyers whose paid deliverable therefore shipped
 * with an empty NAP section. The DFS checker is synchronous and stamps
 * its own failures, so a stuck row means the PROCESS died mid-run; only
 * an out-of-band sweep can recover it.
 *
 * These are the invariants that keep the sweep both effective and safe to
 * run hourly against real DFS spend:
 *
 *   1. A row still inside its provider's in-flight window is never
 *      touched — reaping a live audit would overwrite a real result.
 *   2. DFS (synchronous, 5-9s) and BrightLocal (async, lazily finalized)
 *      get different thresholds. Using the DFS threshold on a BL row
 *      would kill legitimately-pending BL work.
 *   3. A location that keeps dying still gets marked failed (the
 *      re-audit unblock is free) but stops consuming retries, so a
 *      permanently-broken location can't burn DFS budget every hour.
 *   4. Exhausting the per-tick retry budget degrades to fail_only, never
 *      to 'leave' — the unblock must happen even when the retry can't.
 */

import {
  decideReap,
  reapKey,
  stuckThresholdMs,
  reapErrorMessage,
  formatAge,
  DFS_STUCK_AFTER_MS,
  BRIGHTLOCAL_STUCK_AFTER_MS,
  MAX_REAP_RETRIES_PER_LOCATION,
  REAP_ERROR_PREFIX,
  type ReapCandidate,
} from '../lib/citations/reapStuckAudits';

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failures++;
    console.error(`✗ ${label} — got ${g}, want ${w}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

const NOW = Date.parse('2026-09-03T20:00:00.000Z');

function candidate(
  overrides: Partial<ReapCandidate> & { ageMs: number }
): ReapCandidate {
  const { ageMs, ...rest } = overrides;
  return {
    id: 'audit-1',
    client_id: 'client-1',
    location_id: 'loc-1',
    provider: 'dfs',
    status: 'pending',
    created_at: new Date(NOW - ageMs).toISOString(),
    ...rest,
  } as ReapCandidate;
}

const HEALTHY = {
  nowMs: NOW,
  priorReapsForLocation: 0,
  retryBudgetRemaining: 10,
};

// ─── 1. Thresholds are provider-specific ──────────────────────────────
check('dfs threshold is 15m', stuckThresholdMs('dfs'), 15 * 60 * 1000);
check(
  'brightlocal threshold is 24h',
  stuckThresholdMs('brightlocal'),
  24 * 60 * 60 * 1000
);
check(
  'null provider falls back to the conservative 24h window',
  stuckThresholdMs(null),
  BRIGHTLOCAL_STUCK_AFTER_MS
);
check(
  'unknown provider falls back to the conservative 24h window',
  stuckThresholdMs('some-future-vendor'),
  BRIGHTLOCAL_STUCK_AFTER_MS
);

// ─── 2. Live audits are never reaped ──────────────────────────────────
check(
  'dfs audit 30s old is left alone (the checker takes 5-9s)',
  decideReap(candidate({ ageMs: 30 * 1000 }), HEALTHY).action,
  'leave'
);
check(
  'dfs audit just under 15m is left alone',
  decideReap(candidate({ ageMs: DFS_STUCK_AFTER_MS - 1000 }), HEALTHY).action,
  'leave'
);
check(
  'dfs audit just over 15m is reaped + retried',
  decideReap(candidate({ ageMs: DFS_STUCK_AFTER_MS + 1000 }), HEALTHY).action,
  'fail_and_retry'
);
check(
  'BL audit at 2h is left alone — BL finalizes lazily, 15m would be wrong',
  decideReap(
    candidate({ ageMs: 2 * 60 * 60 * 1000, provider: 'brightlocal', status: 'running' }),
    HEALTHY
  ).action,
  'leave'
);
check(
  'BL audit at 112 days is reaped + retried (the real legacy rows)',
  decideReap(
    candidate({
      ageMs: 112 * 24 * 60 * 60 * 1000,
      provider: 'brightlocal',
      status: 'running',
      location_id: null,
    }),
    HEALTHY
  ).action,
  'fail_and_retry'
);
check(
  'BL audit just over 24h is reaped',
  decideReap(
    candidate({
      ageMs: BRIGHTLOCAL_STUCK_AFTER_MS + 1000,
      provider: 'brightlocal',
      status: 'running',
    }),
    HEALTHY
  ).action,
  'fail_and_retry'
);

// ─── 3. Runaway protection ────────────────────────────────────────────
const atCap = decideReap(candidate({ ageMs: 71 * 24 * 60 * 60 * 1000 }), {
  ...HEALTHY,
  priorReapsForLocation: MAX_REAP_RETRIES_PER_LOCATION,
});
check('location at the retry cap is not retried', atCap.action, 'fail_only');
check(
  'location at the retry cap escalates to the operator',
  atCap.action === 'fail_only' ? atCap.escalate : null,
  true
);
check(
  'one prior reap still allows a retry',
  decideReap(candidate({ ageMs: 71 * 24 * 60 * 60 * 1000 }), {
    ...HEALTHY,
    priorReapsForLocation: MAX_REAP_RETRIES_PER_LOCATION - 1,
  }).action,
  'fail_and_retry'
);

// ─── 4. Budget exhaustion degrades to fail_only, never to leave ───────
const noBudget = decideReap(candidate({ ageMs: 71 * 24 * 60 * 60 * 1000 }), {
  ...HEALTHY,
  retryBudgetRemaining: 0,
});
check(
  'no retry budget still marks the row failed (the unblock is free)',
  noBudget.action,
  'fail_only'
);
check(
  'budget exhaustion does NOT ping the operator — it is not a defect',
  noBudget.action === 'fail_only' ? noBudget.escalate : null,
  false
);

// ─── 5. Unparseable timestamps fail closed, without spending ──────────
const bogus = decideReap(
  { ...candidate({ ageMs: 0 }), created_at: 'not-a-date' },
  HEALTHY
);
check('unparseable created_at is failed, not left', bogus.action, 'fail_only');
check(
  'unparseable created_at does not spend a retry',
  bogus.action === 'fail_only' ? bogus.escalate : null,
  false
);
// created_at is nullable on nap_audits — a null must not throw out of the
// sweep, and must not be read as age 0 (which would 'leave' it forever).
const nullCreated = decideReap(
  { ...candidate({ ageMs: 0 }), created_at: null },
  HEALTHY
);
check('null created_at is failed, not left', nullCreated.action, 'fail_only');
check(
  'null created_at does not spend a retry',
  nullCreated.action === 'fail_only' ? nullCreated.escalate : null,
  false
);

// ─── 6. Reap keys group legacy null-location rows by client ───────────
check('key includes the location', reapKey('c1', 'l1'), 'c1:l1');
check('null location keys to the primary slot', reapKey('c1', null), 'c1:primary');
check(
  'different locations of one client are counted separately',
  reapKey('c1', 'l1') === reapKey('c1', 'l2'),
  false
);

// ─── 7. Error messages carry the marker prior-reap counting relies on ─
const msg = reapErrorMessage('pending', 71 * 24 * 60 * 60 * 1000, 'Detail.');
check('error message starts with the reap marker', msg.startsWith(REAP_ERROR_PREFIX), true);
check('error message names the stuck status', msg.includes("'pending'"), true);
check('error message names the age', msg.includes('71d'), true);
check('formatAge seconds', formatAge(9 * 1000), '9s');
check('formatAge minutes', formatAge(20 * 60 * 1000), '20m');
check('formatAge hours', formatAge(5 * 60 * 60 * 1000), '5h');
check('formatAge days', formatAge(71 * 24 * 60 * 60 * 1000), '71d');

if (failures > 0) {
  console.error(`\nverify-stuck-audit-reaper: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nverify-stuck-audit-reaper: all checks passed');
