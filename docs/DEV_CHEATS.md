# Dev cheat commands

These commands let you test teleport and shards without restarting the server.

## Enabling cheats (in-game)

Type in chat:

**`/devcheats`**

This turns on dev cheats **for you** for the rest of the session. After that you can use `/teleport`, `/moreshards`, and `/tier`. When you leave the world, you’ll need to run `/devcheats` again next time.

(You can still enable cheats at server start via `DEV_MODE` or `PATTERNISLE_DEV_CHEATS=1` if you prefer; then `/teleport` and `/moreshards` work without running `/devcheats` first.)

## Commands

| Command       | Effect |
|---------------|--------|
| `/devcheats`  | Enable dev cheats for yourself so you can use `/teleport`, `/moreshards`, and `/tier`. |
| `/teleport`   | Teleport your character to the center of the arena (shard drop / deposit zone). Uses the same center as the deposit console (x=0, z=0) and raycasts for ground Y. |
| `/moreshards` | Adds shards so you have enough for the next tier. In **tower** mode: adds to carried shards until you reach the next tier threshold (8 → 18 → 30). In other modes: adds up to `TARGET_SHARDS` (25). |
| `/tier`       | Build the next tier of the tower (tower mode only). No shards required. Use up to 3 times to build tiers 1, 2, and 3; tier 3 also activates the roof zone. |

## How to test

1. Join the world and spawn.
2. Type **`/devcheats`** in chat. You should see: “Dev cheats enabled. You can use /teleport and /moreshards.”
3. Type **`/teleport`** to move to the arena center (deposit zone).
4. Type **`/moreshards`** to get shards for the next tier (green message and HUD update).
5. In **tower** mode, type **`/tier`** to build the next tower tier (up to 3); you’ll see “Tier N Unlocked” and the tower will grow.
