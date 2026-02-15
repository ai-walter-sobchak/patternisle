/**
 * Arena bounds for spawn and gameplay. Later can be derived from map.
 */

export const ARENA_BOUNDS = {
  minX: -23, // -26 + 3
  maxX: 23,  //  26 - 3
  minZ: -23, // -26 + 3
  maxZ: 21,  //  24 - 3
  y: 0       // minY(-2) + 2
} as const;

export type ArenaBounds = typeof ARENA_BOUNDS;
