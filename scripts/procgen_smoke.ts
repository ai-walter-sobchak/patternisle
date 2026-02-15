import { generateValidArena } from "../src/server/procgen/generateValidArena";

function main() {
  let fallbackCount = 0;
  for (let i = 1; i <= 50; i++) {
    const seed = `match_${i}`;
    const { spec, attempt, usedSeed } = generateValidArena(seed, 8);
    if (usedSeed.startsWith("fallback")) fallbackCount++;
    console.log(
      `[${i}] seed=${seed} -> usedSeed=${usedSeed} attempts=${attempt} rings=${spec.rings} segments=${spec.segments} spokes=${spec.spokes}`
    );
  }
  console.log(`Fallback used: ${fallbackCount}/50`);

  // Regression: CI must see 0 fallbacks (maxAttempts remains <= 8)
  if (fallbackCount > 0) {
    process.exit(1);
  }
}

main();
