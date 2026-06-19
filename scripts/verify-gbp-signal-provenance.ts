import {
  GBP_SIGNAL_PROVENANCE,
  PLACES_PHOTOS_CAP,
} from '../lib/google/gbpSignalProvenance';
import {
  TURF_COACH_SYSTEM_PROMPT,
  formatPhotosCount,
} from '../lib/anthropic/prompts/turfCoach';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('ok  :', msg);
}

// The photo cap is the documented constant AND drives the renderer —
// keeps them from drifting apart.
assert(PLACES_PHOTOS_CAP === 10, 'Places photo cap constant is 10');
assert(
  formatPhotosCount(PLACES_PHOTOS_CAP).startsWith(`${PLACES_PHOTOS_CAP}+`),
  'formatPhotosCount renders the cap value as "N+"',
);
assert(
  formatPhotosCount(PLACES_PHOTOS_CAP - 1) === String(PLACES_PHOTOS_CAP - 1),
  'formatPhotosCount renders below-cap counts as the plain number',
);

// THE ANTI-ROT GUARD: every signal flagged 'caveated' must still have its
// guardrail present in the live AI Coach system prompt. If someone deletes
// or weakens a guard (or adds a caveated field without one), this fails.
const caveated = GBP_SIGNAL_PROVENANCE.filter((s) => s.safety === 'caveated');
assert(caveated.length >= 4, 'at least the 4 known caveated signals are tracked');
for (const s of caveated) {
  assert(
    typeof s.promptGuardMarker === 'string' && s.promptGuardMarker.length > 0,
    `caveated signal "${s.field}" declares a promptGuardMarker`,
  );
  assert(
    TURF_COACH_SYSTEM_PROMPT.includes(s.promptGuardMarker as string),
    `AI Coach system prompt still guards "${s.field}" (marker: "${s.promptGuardMarker}")`,
  );
}

// Keep the table honest: 'safe' signals carry no caveat/marker.
for (const s of GBP_SIGNAL_PROVENANCE.filter((x) => x.safety === 'safe')) {
  assert(
    s.caveat === null && s.promptGuardMarker === null,
    `safe signal "${s.field}" carries no caveat/marker`,
  );
}

console.log('\nALL PASS');
