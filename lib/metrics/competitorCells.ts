/**
 * Build a 81-cell HeatmapCell[] for a named competitor by walking the
 * scan_points table.
 *
 * For each grid cell, we look at that point's `competitors` JSONB array (the
 * top-3 local-pack items at that lat/lng) and find the entry whose name
 * matches `competitorName` (case-insensitive). If found, the cell's rank is
 * `rank_group` (1-3); otherwise null (not in the pack at that location).
 *
 * Used by the competitor-overlay toggle in HeatmapWithToggle.
 */

import type { RawCompetitor } from './competitors';

export type CompetitorCellInput = {
  grid_x: number;
  grid_y: number;
  competitors: unknown;
};

export type CompetitorCells = {
  x: number;
  y: number;
  rank: number | null;
};

export function buildCompetitorCells(
  points: CompetitorCellInput[],
  competitorName: string
): CompetitorCells[] {
  const target = competitorName.trim().toLowerCase();
  return points.map((p) => {
    const list = (p.competitors ?? []) as RawCompetitor[];
    const match = list.find(
      (c) => (c?.name ?? '').toString().trim().toLowerCase() === target
    );
    const rank =
      match?.rank_group ?? match?.rank_absolute ?? null;
    return {
      x: p.grid_x,
      y: p.grid_y,
      rank: rank === null ? null : Number(rank),
    };
  });
}
