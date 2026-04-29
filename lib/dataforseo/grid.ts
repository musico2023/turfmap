/**
 * 9x9 geo-grid coordinate generator for TurfMap scans.
 *
 * Given a center lat/lng and a service radius in miles, returns the 81 grid
 * points that fan out symmetrically from the center. The grid is `2 * radius`
 * miles edge-to-edge, so spacing between adjacent points is `radius / 4` mi
 * for the default 9x9 / 1.6mi configuration (= 0.4 mi spacing).
 *
 * Convention: y=0 is the NORTHERN row, y=gridSize-1 is the SOUTHERN row,
 * which matches how the heatmap renders top-down on screen.
 */

export type GridPoint = {
  /** column index, 0..gridSize-1, west→east */
  x: number;
  /** row index, 0..gridSize-1, north→south */
  y: number;
  lat: number;
  lng: number;
};

const MILES_PER_LAT_DEG = 69.0467;

export type GridConfig = {
  centerLat: number;
  centerLng: number;
  /** Must be odd (so a single center cell exists). Default 9. */
  gridSize?: number;
  /** Half-width of the grid in miles. Default 1.6. */
  radiusMiles?: number;
};

export function generateGridCoordinates(cfg: GridConfig): GridPoint[] {
  const { centerLat, centerLng, gridSize = 9, radiusMiles = 1.6 } = cfg;

  if (gridSize < 3 || gridSize % 2 === 0) {
    throw new Error(`gridSize must be odd and >= 3 (got ${gridSize})`);
  }
  if (radiusMiles <= 0) {
    throw new Error(`radiusMiles must be > 0 (got ${radiusMiles})`);
  }
  if (centerLat < -90 || centerLat > 90) {
    throw new Error(`centerLat out of range: ${centerLat}`);
  }
  if (centerLng < -180 || centerLng > 180) {
    throw new Error(`centerLng out of range: ${centerLng}`);
  }

  const half = (gridSize - 1) / 2;
  const spacingMiles = radiusMiles / half;
  const milesPerLngDeg =
    MILES_PER_LAT_DEG * Math.cos((centerLat * Math.PI) / 180);

  const points: GridPoint[] = [];
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const dxMiles = (x - half) * spacingMiles; // east positive
      const dyMiles = (half - y) * spacingMiles; // north positive
      const lat = centerLat + dyMiles / MILES_PER_LAT_DEG;
      const lng = centerLng + dxMiles / milesPerLngDeg;
      points.push({
        x,
        y,
        lat: round7(lat),
        lng: round7(lng),
      });
    }
  }
  return points;
}

function round7(n: number): number {
  return Math.round(n * 1e7) / 1e7;
}
