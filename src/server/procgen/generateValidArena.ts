import { generateArenaSpec } from "./generateArenaSpec";
import { validateSpec } from "./validateSpec";
import { validateConnectivity } from "./validateConnectivity";
import type { MapSpecV1 } from "./spec";

export interface GenerateValidArenaOptions {
  size?: number;
  attempts?: number;
}

export function generateValidArena(
  seed: string,
  attemptsOrOpts: number | GenerateValidArenaOptions = 16
): { spec: MapSpecV1; attempt: number; usedSeed: string } {
  const opts: GenerateValidArenaOptions =
    typeof attemptsOrOpts === 'number' ? { attempts: attemptsOrOpts } : attemptsOrOpts;
  const attempts = opts.attempts ?? 16;
  const size = opts.size ?? 250;
  const fallback = `fallback_v1_size${size}_rings4`;
  for (let i = 0; i < attempts; i++) {
    const usedSeed = i === 0 ? seed : `${seed}:r${i}`;
    const spec = generateArenaSpec(usedSeed, { size, rings: 4, teams: 4 });
    const v = validateSpec(spec);
    if (!v.ok) continue;
    const c = validateConnectivity(spec);
    if (!c.ok) continue;
    return { spec, attempt: i + 1, usedSeed };
  }
  const spec = generateArenaSpec(fallback, { size, rings: 4, teams: 4 });
  console.error('[procgen] fallback triggered', { seed, attempt: attempts, usedSeed: fallback });
  if (process.env.NODE_ENV !== 'production') {
    console.error('[procgen] hard fail in dev — no silent fallback');
    process.exit(1);
  }
  return { spec, attempt: attempts + 1, usedSeed: fallback };
}
