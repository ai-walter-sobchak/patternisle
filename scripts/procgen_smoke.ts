import { createHash } from "node:crypto";
import { generateValidArena } from "../src/server/procgen/generateValidArena";
import { generateArenaSpec } from "../src/server/procgen/generateArenaSpec";
import type { MapSpecV1 } from "../src/server/procgen/spec";

/** Stable JSON: sort object keys so serialization is deterministic. No timestamp stripping needed for MapSpecV1. */
function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ":" + stableStringify((obj as Record<string, unknown>)[k]));
  return "{" + pairs.join(",") + "}";
}

function specHash(spec: MapSpecV1): string {
  return createHash("sha256").update(stableStringify(spec), "utf8").digest("hex");
}

function main() {
  let fallbackCount = 0;
  const seeds = Array.from({ length: 50 }, (_, i) => `match_${i + 1}`);

  for (const seed of seeds) {
    const { spec, attempt, usedSeed } = generateValidArena(seed, 16);
    if (usedSeed.startsWith("fallback")) fallbackCount++;

    // Determinism: generate same seed again with same opts (rings from first spec)
    const spec2 = generateArenaSpec(usedSeed, { size: 250, rings: spec.rings, teams: 4 });
    const hash1 = specHash(spec);
    const hash2 = specHash(spec2);
    if (hash1 !== hash2) {
      console.error(`[FAIL] seed=${seed} usedSeed=${usedSeed} determinism: hashes differ`);
      console.error(`  hash1=${hash1}`);
      console.error(`  hash2=${hash2}`);
      process.exit(1);
    }

    console.log(
      `[${seed}] usedSeed=${usedSeed} attempts=${attempt} rings=${spec.rings} segments=${spec.segments} spokes=${spec.spokes} hash=${hash1.slice(0, 8)}`
    );
  }

  console.log(`Fallback used: ${fallbackCount}/${seeds.length}`);

  if (fallbackCount > 0) {
    console.error("Regression: CI must see 0 fallbacks (maxAttempts remains <= 16)");
    process.exit(1);
  }

  console.log("OK: no fallbacks, determinism verified for all seeds.");
}

main();
