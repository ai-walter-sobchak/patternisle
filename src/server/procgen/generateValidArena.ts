import { generateArenaSpec } from "./generateArenaSpec";
import { validateSpec } from "./validateSpec";
import { validateConnectivity } from "./validateConnectivity";
import { MapSpecV1 } from "./spec";

export function generateValidArena(seed: string, attempts = 16): { spec: MapSpecV1; attempt: number; usedSeed: string } {
  const fallback = "fallback_v1_size250_rings4";
  for (let i = 0; i < attempts; i++) {
    const usedSeed = i === 0 ? seed : `${seed}:r${i}`;
    const spec = generateArenaSpec(usedSeed, { size: 250, rings: 4, teams: 4 });
    const v = validateSpec(spec);
    if (!v.ok) continue;
    const c = validateConnectivity(spec);
    if (!c.ok) continue;
    return { spec, attempt: i + 1, usedSeed };
  }
  // fallback: no valid spec in max attempts
  const spec = generateArenaSpec(fallback, { size: 250, rings: 4, teams: 4 });
  console.error('[procgen] fallback triggered', { seed, attempt: attempts, usedSeed: fallback });
  if (process.env.NODE_ENV !== 'production') {
    console.error('[procgen] hard fail in dev — no silent fallback');
    process.exit(1);
  }
  return { spec, attempt: attempts + 1, usedSeed: fallback };
}
