import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateValidArena } from "../src/server/procgen/generateValidArena";
import { validateConnectivity } from "../src/server/procgen/validateConnectivity";
import { validateSpec } from "../src/server/procgen/validateSpec";
import { bakeGridFromSpec, toCell } from "../src/server/procgen/gridBake";
import type { MapSpecV1 } from "../src/server/procgen/spec";

const OUT_DIR = join(process.cwd(), "dist", "procgen_test", "maps");
const FIXED_SEEDS = Array.from({ length: 20 }, (_, i) => `match_${i + 1}`);

function fsSafeSeed(seed: string): string {
  return seed.replace(/:/g, "_");
}

function fail(seed: string, reason: string, extra?: Record<string, unknown>): never {
  const msg = extra ? `${reason} ${JSON.stringify(extra)}` : reason;
  console.error(`[FAIL] seed=${seed} reason=${msg}`);
  process.exit(1);
}

/** Map sanity checks on re-loaded spec (same checks the game would care about). */
function mapSanityChecks(spec: MapSpecV1, seed: string): void {
  if (spec.v !== 1) fail(seed, "spec.v must be 1");
  if (spec.size <= 0) fail(seed, "spec.size must be > 0");
  if (![3, 4, 5].includes(spec.rings)) fail(seed, "spec.rings must be 3, 4, or 5");
  if (!spec.ringRadii || spec.ringRadii.length !== spec.rings) fail(seed, "spec.ringRadii length must match spec.rings");
  const radii = spec.ringRadii;
  for (let i = 0; i < radii.length - 1; i++) {
    if (!(radii[i] > radii[i + 1] && radii[i + 1] > 0)) fail(seed, "ringRadii must be strictly decreasing and > 0");
  }
  if (radii.length > 0 && radii[radii.length - 1] <= 0) fail(seed, "innermost ring radius must be > 0");

  if (spec.spawnZones.length !== 4) fail(seed, "must have exactly 4 spawnZones");
  const teams = new Set(spec.spawnZones.map((s) => s.teamId));
  if (teams.size !== 4) fail(seed, "spawnZones must include teamId 0..3 exactly once");

  if (spec.objective.radius <= 0) fail(seed, "objective.radius must be > 0");
  if (spec.objective.center.x !== spec.center.x || spec.objective.center.y !== spec.center.y) {
    fail(seed, "objective must be centered at spec.center");
  }
  if (spec.wallSegments.length === 0) fail(seed, "wallSegments must not be empty");

  // Bounds
  const inBoundsRect = (x: number, y: number, w: number, h: number) =>
    x >= 0 && y >= 0 && x + w <= spec.size && y + h <= spec.size;
  for (const s of spec.spawnZones) {
    const { x, y, w, h } = s.rect;
    if (!inBoundsRect(x, y, w, h)) fail(seed, `spawn rect out of bounds for team ${s.teamId}`);
    if (w <= 0 || h <= 0) fail(seed, `spawn rect invalid size for team ${s.teamId}`);
  }

  // No overlapping solids in spawns: each spawn has at least one walkable cell (3x3 around center)
  const g = bakeGridFromSpec(spec, 1);
  const cropInfo =
    g.originX !== undefined && g.originY !== undefined
      ? { originX: g.originX, originY: g.originY, size: g.size }
      : undefined;

  for (const s of spec.spawnZones) {
    const cx = s.rect.x + s.rect.w / 2;
    const cy = s.rect.y + s.rect.h / 2;
    const sc = toCell(g, { x: cx, y: cy });
    let found = false;
    for (let dy = -1; dy <= 1 && !found; dy++) {
      for (let dx = -1; dx <= 1 && !found; dx++) {
        const nx = sc.x + dx;
        const ny = sc.y + dy;
        if (nx < 0 || ny < 0 || nx >= g.size || ny >= g.size) continue;
        const idx = ny * g.size + nx;
        if (!g.blocked[idx]) found = true;
      }
    }
    if (!found) fail(seed, `team ${s.teamId} spawn has no walkable cell in 3x3 around center`, cropInfo);
  }

  // Prize (objective) exists and is in bounds
  const oc = toCell(g, spec.objective.center);
  if (oc.x < 0 || oc.y < 0 || oc.x >= g.size || oc.y >= g.size) {
    fail(seed, "objective center out of grid bounds", cropInfo);
  }
}

async function main() {
  const seeds = [...FIXED_SEEDS];
  const randomSeed = `random_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  seeds.push(randomSeed);
  console.log(`Build test: ${seeds.length} seeds (fixed + 1 random). Random seed (not gating): ${randomSeed}`);

  await mkdir(OUT_DIR, { recursive: true });

  for (const seed of seeds) {
    const { spec, usedSeed } = generateValidArena(seed, 16);
    if (usedSeed.startsWith("fallback")) {
      fail(seed, "fallback used; build test expects valid spec");
    }

    const v = validateSpec(spec);
    if (!v.ok) fail(seed, `validateSpec failed: ${v.errors.join("; ")}`);

    const c = validateConnectivity(spec);
    if (!c.ok) fail(seed, `validateConnectivity failed: ${c.errors.join("; ")}`);

    const dir = join(OUT_DIR, fsSafeSeed(usedSeed));
    await mkdir(dir, { recursive: true });
    const mapPath = join(dir, "map.json");
    const json = JSON.stringify(spec, null, 2);
    await writeFile(mapPath, json, "utf8");

    const raw = await readFile(mapPath, "utf8");
    const loaded = JSON.parse(raw) as MapSpecV1;
    mapSanityChecks(loaded, seed);
  }

  console.log(`OK: emitted and re-validated ${seeds.length} maps under ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
