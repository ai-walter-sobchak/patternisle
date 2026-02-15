/**
 * Procedural map themes: block IDs for floor, wall, trim, and accent.
 * Used with round seed so each round can look completely different.
 */

export type MapTheme = {
  id: string;
  label: string;
  floorId: number;
  wallId: number;
  trimId: number;   // top cap / trim at y=2
  accentId: number; // sparse accent on walls
  accentRate: number; // 0..1 probability per wall cell
};

/**
 * FNV-1a 32-bit hash, deterministic across platforms.
 */
export function hash32(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic "random" float 0..1 from a string key.
 */
export function rand01(key: string): number {
  const h = hash32(key);
  return h / 0xffffffff;
}

/** Block catalog for arena (matches assets/map.json blockTypes; no water). */
export type BlockCatalogEntry = {
  id: number;
  name: string;
  textureUri: string;
  isCustom: boolean;
  isMultiTexture: boolean;
};

export const BLOCK_CATALOG: BlockCatalogEntry[] = [
  { id: 1, name: "andesite", textureUri: "blocks/andesite.png", isCustom: false, isMultiTexture: false },
  { id: 2, name: "birch-leaves", textureUri: "blocks/birch-leaves.png", isCustom: false, isMultiTexture: false },
  { id: 3, name: "bricks", textureUri: "blocks/bricks.png", isCustom: false, isMultiTexture: false },
  { id: 4, name: "coal-ore", textureUri: "blocks/coal-ore.png", isCustom: false, isMultiTexture: false },
  { id: 5, name: "cobblestone", textureUri: "blocks/cobblestone.png", isCustom: false, isMultiTexture: false },
  { id: 6, name: "grass-block-pine", textureUri: "blocks/grass-block-pine", isCustom: false, isMultiTexture: true },
  { id: 7, name: "grass-block", textureUri: "blocks/grass-block", isCustom: false, isMultiTexture: true },
  { id: 8, name: "grass-flower-block-pine", textureUri: "blocks/grass-flower-block-pine", isCustom: false, isMultiTexture: true },
  { id: 9, name: "grass-flower-block", textureUri: "blocks/grass-flower-block", isCustom: false, isMultiTexture: true },
  { id: 10, name: "oak-leaves", textureUri: "blocks/oak-leaves.png", isCustom: false, isMultiTexture: false },
  { id: 11, name: "oak-log", textureUri: "blocks/oak-log", isCustom: false, isMultiTexture: true },
  { id: 12, name: "sand", textureUri: "blocks/sand.png", isCustom: false, isMultiTexture: false },
  { id: 13, name: "spruce-leaves", textureUri: "blocks/spruce-leaves.png", isCustom: false, isMultiTexture: false },
  { id: 14, name: "spruce-log", textureUri: "blocks/spruce-log", isCustom: false, isMultiTexture: true },
  { id: 15, name: "stone", textureUri: "blocks/stone.png", isCustom: false, isMultiTexture: false },
];

const catalogById = new Map(BLOCK_CATALOG.map((b) => [b.id, b]));

/** Get block type records for the given IDs (for Hytopia map blockTypes). */
export function getBlockTypesForIds(ids: number[]): BlockCatalogEntry[] {
  const seen = new Set<number>();
  const out: BlockCatalogEntry[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = catalogById.get(id);
    if (entry) out.push(entry);
  }
  return out;
}

/** Preset themes using real block IDs from the catalog. */
export const THEMES: MapTheme[] = [
  { id: "meadow", label: "Meadow", floorId: 7, wallId: 15, trimId: 15, accentId: 9, accentRate: 0.06 },
  { id: "stone", label: "Stone", floorId: 15, wallId: 5, trimId: 15, accentId: 3, accentRate: 0.08 },
  { id: "dark", label: "Dark", floorId: 5, wallId: 15, trimId: 5, accentId: 4, accentRate: 0.10 },
  { id: "bright", label: "Bright", floorId: 9, wallId: 7, trimId: 9, accentId: 8, accentRate: 0.12 },
  { id: "sand", label: "Sand", floorId: 12, wallId: 15, trimId: 5, accentId: 15, accentRate: 0.07 },
  { id: "brick", label: "Brick", floorId: 15, wallId: 3, trimId: 5, accentId: 15, accentRate: 0.09 },
  { id: "pine", label: "Pine", floorId: 6, wallId: 14, trimId: 11, accentId: 13, accentRate: 0.05 },
  { id: "garden", label: "Garden", floorId: 7, wallId: 11, trimId: 9, accentId: 2, accentRate: 0.11 },
];

/** Pick a preset theme by round seed (deterministic). */
export function pickTheme(roundSeed: string): MapTheme {
  const idx = hash32(roundSeed) % THEMES.length;
  return THEMES[idx];
}

/** IDs that work well as floor (walkable, solid). */
const FLOOR_CANDIDATES = [6, 7, 8, 9, 12, 15, 5, 3];

/** IDs that work well as walls. */
const WALL_CANDIDATES = [15, 5, 3, 1, 11, 14, 7];

/**
 * Generate a theme procedurally from round seed so each round can be completely different.
 * Picks floor, wall, trim, accent from the catalog and a deterministic accent rate.
 */
export function generateTheme(roundSeed: string): MapTheme {
  const r = (key: string) => rand01(roundSeed + key);
  const pick = <T>(arr: T[], key: string): T => arr[Math.floor(r(key) * arr.length) % arr.length];

  const floorId = pick(FLOOR_CANDIDATES, "floor");
  let wallId = pick(WALL_CANDIDATES, "wall");
  let trimId = pick([15, 5, 3, 1], "trim");
  let accentId = pick([...BLOCK_CATALOG.map((b) => b.id)].filter((id) => id !== 16), "accent");

  // Avoid same block for wall and trim when possible
  if (trimId === wallId) trimId = wallId === 15 ? 5 : 15;
  // Accent should usually differ from wall for visibility
  if (accentId === wallId) accentId = wallId === 15 ? 3 : 15;

  const accentRate = 0.04 + r("rate") * 0.10;

  return {
    id: "proc",
    label: "Procedural",
    floorId,
    wallId,
    trimId,
    accentId,
    accentRate,
  };
}
