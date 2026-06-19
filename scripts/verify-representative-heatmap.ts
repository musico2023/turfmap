import { buildRepresentativeCells } from '../components/marketing/representativeHeatmap';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('ok  :', msg);
}

const SEED = '2Zk85zoxv4';

const a = buildRepresentativeCells(SEED, 64);
const b = buildRepresentativeCells(SEED, 64);
const other = buildRepresentativeCells('XemS1OVQCa', 64);

assert(a.length === 81, '81 cells total');
assert(a.filter((c) => c.rank === null).length === 64, 'exactly 64 dark (null) cells');
assert(a.filter((c) => c.rank !== null).length === 17, 'exactly 17 lit cells');
assert(
  a.every((c) => c.rank === null || c.rank === 1 || c.rank === 2 || c.rank === 3),
  'ranks are only null | 1 | 2 | 3',
);
assert(a.every((c) => c.x >= 0 && c.x < 9 && c.y >= 0 && c.y < 9), 'coords in 9x9 bounds');
assert(JSON.stringify(a) === JSON.stringify(b), 'deterministic for identical seed');
assert(JSON.stringify(a) !== JSON.stringify(other), 'pattern varies by seed');
assert(
  buildRepresentativeCells(SEED, 200).every((c) => c.rank === null),
  'darkCount > 81 clamps to all dark',
);
assert(
  buildRepresentativeCells(SEED, 0).every((c) => c.rank !== null),
  'darkCount 0 => no dark cells',
);
assert(
  buildRepresentativeCells(SEED, -5).every((c) => c.rank !== null),
  'negative darkCount clamps to 0 dark',
);

console.log('\nALL PASS');
