import type { HeatmapCell } from '@/components/turfmap/HeatmapGrid';

const GRID = 9;
const TOTAL = GRID * GRID; // 81
const CENTER = (GRID - 1) / 2; // 4

/** Deterministic 32-bit FNV-1a hash. Pure arithmetic — server-render safe. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic [0,1) from a base hash + index (mulberry32-style). */
function rand(base: number, i: number): number {
  let t = (base + i * 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Build a representative 81-cell heatmap for a cold-email prospect.
 * Exactly `darkCount` cells are null (red/invisible); the rest cluster
 * near the center with brighter ranks in the core. Deterministic and
 * seeded on prospect_id (stable per prospect, server-safe — no
 * Math.random/Date.now). The page labels this "representative", not a
 * literal per-cell map.
 */
export function buildRepresentativeCells(seed: string, darkCount: number): HeatmapCell[] {
  const dark = Math.max(0, Math.min(TOTAL, Math.round(darkCount)));
  const lit = TOTAL - dark;
  const base = hashSeed(seed);
  const scored: { i: number; weight: number }[] = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const i = y * GRID + x;
      const dist = Math.hypot(x - CENTER, y - CENTER);
      const jitter = rand(base, i) * 1.6;
      scored.push({ i, weight: dist + jitter });
    }
  }
  scored.sort((p, q) => p.weight - q.weight);
  const rankFor = (order: number): number => {
    const frac = lit <= 1 ? 0 : order / (lit - 1);
    if (frac < 0.34) return 1;
    if (frac < 0.67) return 2;
    return 3;
  };
  const rankByCell = new Map<number, number | null>();
  scored.forEach((c, order) => {
    rankByCell.set(c.i, order < lit ? rankFor(order) : null);
  });
  const cells: HeatmapCell[] = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      cells.push({ x, y, rank: rankByCell.get(y * GRID + x) ?? null });
    }
  }
  return cells;
}
