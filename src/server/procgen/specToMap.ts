/**
 * Convert MapSpecV1 to Hytopia map format (blockTypes + blocks).
 * Spec 2D (x,y) maps to world (x - center.x, y=0|1, y - center.y) so arena is centered at (0, 0).
 * Uses theme for floor, wall, trim (y=2 band), and sparse accent; theme defaults to procedural from spec.seed.
 * Renders spec.cover as obstacles (pillar/crate/lowwall) to break up wide open areas.
 */

import type { MapSpecV1 } from "./spec";
import { bakeGridFromSpec } from "./gridBake";
import type { MapTheme } from "./themes";
import { generateTheme, getBlockTypesForIds } from "./themes";
import { rand01 } from "./themes";

/** Wall height in blocks so you can't see over them; creates winding corridors. */
const WALL_HEIGHT = 5;

/** Trim band at this Y (second layer of wall). */
const TRIM_Y = 2;

/** Block IDs for cover obstacles (from BLOCK_CATALOG: stone, bricks, cobblestone). */
const COVER_BLOCK_IDS = { pillar: 15, crate: 3, lowwall: 5 } as const;

export type HytopiaMap = {
  blockTypes: Array<{ id: number; name: string; textureUri: string; isCustom: boolean; isMultiTexture: boolean }>;
  blocks: Record<string, number>;
};

/**
 * Rasterize spec to 3D blocks: floor at y=0, walls stacked up to WALL_HEIGHT.
 * Trim at y=2; wall cells may use accent block with theme.accentRate (deterministic from spec.seed).
 * If theme is omitted, one is generated from spec.seed so each round stays deterministic and varied.
 */
export function specToMap(spec: MapSpecV1, theme?: MapTheme): HytopiaMap {
  const t = theme ?? generateTheme(spec.seed);
  const g = bakeGridFromSpec(spec, 1);
  const center = spec.center;
  const ox = g.originX ?? 0;
  const oy = g.originY ?? 0;
  const blocks: Record<string, number> = {};
  const seed = spec.seed;

  for (let ly = 0; ly < g.size; ly++) {
    for (let lx = 0; lx < g.size; lx++) {
      const wx = ox + lx - center.x;
      const wz = oy + ly - center.y;
      const idx = ly * g.size + lx;
      const blocked = g.blocked[idx] !== 0;

      blocks[`${wx},0,${wz}`] = t.floorId;
      if (blocked) {
        for (let y = 1; y <= WALL_HEIGHT; y++) {
          const key = `${wx},${y},${wz}`;
          if (y === TRIM_Y) {
            blocks[key] = t.trimId;
          } else {
            const r = rand01(seed + key);
            blocks[key] = r < t.accentRate ? t.accentId : t.wallId;
          }
        }
      }
    }
  }

  // Place cover obstacles (pillar, crate, lowwall) to break up open space; only on walkable cells
  const coverBlockId = (kind: "pillar" | "crate" | "lowwall") => COVER_BLOCK_IDS[kind];
  const worldToGridIdx = (wx: number, wz: number): number | null => {
    const sx = wx + center.x;
    const sy = wz + center.y;
    const lx = sx - ox;
    const ly = sy - oy;
    if (lx < 0 || ly < 0 || lx >= g.size || ly >= g.size) return null;
    return ly * g.size + lx;
  };
  for (const c of spec.cover) {
    const wx = c.center.x - center.x;
    const wz = c.center.y - center.y;
    const r = c.radius;
    const bid = coverBlockId(c.kind);
    const height = c.kind === "pillar" ? 3 : 1;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (dx * dx + dz * dz > r * r + 0.5) continue;
        const idx = worldToGridIdx(wx + dx, wz + dz);
        if (idx == null || g.blocked[idx] !== 0) continue;
        for (let y = 1; y <= height; y++) {
          blocks[`${wx + dx},${y},${wz + dz}`] = bid;
        }
      }
    }
  }

  const blockTypes = getBlockTypesForIds([
    t.floorId,
    t.wallId,
    t.trimId,
    t.accentId,
    ...Object.values(COVER_BLOCK_IDS),
  ]);
  return { blockTypes, blocks };
}
