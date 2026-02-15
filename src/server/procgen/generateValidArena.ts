import { generateArenaSpec } from "./generateArenaSpec";
import { validateSpec } from "./validateSpec";
import { validateConnectivity } from "./validateConnectivity";
import { MapSpecV1 } from "./spec";

export function generateValidArena(seed: string, attempts = 8): { spec: MapSpecV1; attempt: number; usedSeed: string } {
  const fallback = "fallback_v1_size250_rings3";
  for (let i = 0; i < attempts; i++) {
    const usedSeed = i === 0 ? seed : `${seed}:r${i}`;
    const spec = generateArenaSpec(usedSeed, { size: 250, rings: 3, teams: 4 });
    const v = validateSpec(spec);
    if (!v.ok) continue;
    const c = validateConnectivity(spec);
    if (!c.ok) continue;
    return { spec, attempt: i + 1, usedSeed };
  }
  // fallback
  const spec = generateArenaSpec(fallback, { size: 250, rings: 3, teams: 4 });
  return { spec, attempt: attempts + 1, usedSeed: fallback };
}
