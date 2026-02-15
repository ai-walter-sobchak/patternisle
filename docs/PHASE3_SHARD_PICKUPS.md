# Phase 3: Shard Pickups

## Deterministic pickup IDs

Pickup IDs are **deterministic**: `shard-0`, `shard-1`, … `shard-<index>`. No random strings. This keeps replication and debugging consistent across server and clients.

## RNG choice (Mulberry32)

We use **Mulberry32** for deterministic placement:

- **Deterministic**: Same seed → same sequence of `rng()` values, so same matchId always yields the same shard positions.
- **Minimal state**: Single 32-bit seed; no extra state to sync or persist.
- **Speed**: A few integer ops per call; fine for spawning a small number of pickups once per match.
- **Quality**: Good enough for game use (placement, values); not for crypto.

`Math.random()` is not used for placement so that server and any replay/tests see identical positions for a given seed.

## How tick is wired in index.ts

1. After `world.loadMap(worldMap)`:
   - `ShardSystem` is created with `world` and `worldState`.
   - `shardSystem.generateAndSpawnPickups(worldState.seed)` runs once to spawn pickups for the match.
2. Each world tick:
   - `world.loop.on(WorldLoopEvent.TICK_START, ({ tickDeltaMs }) => { shardSystem.tick(tickDeltaMs); });`
   - So every tick, `ShardSystem.tick(dt)` runs: it checks connected players vs uncollected pickups (with a cheap AABB early-out using `scanRadius` so we don’t do a full O(players × pickups) distance check), applies proximity pickup, updates `WorldState` and chat, and despawns the entity.

## Manual test checklist

- [ ] **Map load / spawn**: Server starts, map loads, player spawns at (0, 10, 0). No errors.
- [ ] **/rocket**: `/rocket` still launches the player. No regression.
- [ ] **/seed, /state, /setmatch**: Commands still work; `/state` shows `shards` for the player.
- [ ] **Determinism**: Note current `matchId`/seed with `/seed`. Restart server, use `/setmatch <same_id>` (with no players connected or DEV_MODE). Join; shard pickup positions should match the previous run.
- [ ] **/shards**: Shows "Shards: X (you). Remaining pickups: Y". Y decreases as you collect.
- [ ] **Proximity pickup**: Walk into a shard (within ~2.5 m). You get "+N shards (total T)" in chat and the pickup disappears.
- [ ] **Anti-dupe**: Same pickup never awards twice; after collect it stays gone.
- [ ] **Multiplayer**: Second client joins; when one player collects a shard, it disappears for both. No double-award.
- [ ] **/spawnshards (DEV_MODE only)**: Set `DEV_MODE = true` in index.ts, restart. `/spawnshards` regenerates pickups; without DEV_MODE the command is refused.
- [ ] **Regen safety**: Calling `regeneratePickups(seed)` multiple times despawns all existing shard entities, clears the map, resets the spawned flag, and respawns; no entity leaks.
