# Patternisle — Project Synopsis & Recommended Next Steps

**Generated:** February 2025  
**Purpose:** Single reference for where the project stands and what to do next.

---

## 1. Project Overview

**Name:** Patternisle  
**Stack:** [Hytopia](https://github.com/hytopiagg/sdk) SDK (v0.15.x), TypeScript, optional `@hytopia.com/assets`.  
**Entry:** `index.ts` → `startServer()` with one **WorldState** per server run (match).  
**UI:** Server-authoritative HUD via `player.ui.load('ui/index.html')` and `player.ui.sendData()`; schema in `src/server/schema/hudMessages.ts`, client in `assets/ui/hud.js` + `hud.css`.

**What it is:** A multiplayer/single-player arena game with procedural arenas, shard collection, combat, power-ups, and multiple game modes. Players move, jump, collect shards, fight (melee), use power-ups, and compete in timed or objective-based rounds.

---

## 2. Architecture (High Level)

| Layer | Role |
|-------|------|
| **index.ts** | Bootstrap: load map, wire systems/services, register events (JOIN, TICK, chat commands). |
| **WorldState** | Single source of truth: `players`, `roundState`, `matchConfig`, `score`, `powerUps`, `spawn`, `towerState`, `survivalState`, `timeTrialState`, `objective`, `procgenSpec`, etc. No persistence. |
| **RoundController** | Round lifecycle: LOBBY → STARTING → RUNNING → ENDED → RESETTING. Starts match (procgen + load map), ticks timer, ends match, triggers reset. |
| **Systems** | ShardSystem, PowerUpSystem, ObjectiveSystem, SpawnSystem, TowerSystem, DepositSystem, BotManager. |
| **Services** | HudService (send HUD/feed/toast), ScoreService (leaderboard, join mid-round), CombatService (health, melee, KO, spawn protection). |

**Flow:** Player joins → lobby → selects mode (UI `set_mode`) → Start → RoundController runs procgen, loads map, spawns shards/power-ups → RUNNING → win/end → RESETTING → LOBBY or next round.

---

## 3. Game Modes — Current Status

| Mode | Status | Notes |
|------|--------|--------|
| **MULTI** | Implemented | Shard race with bots; first to `TARGET_SHARDS` (25) wins. |
| **SOLO** | Implemented | Same race vs bots, single player. |
| **tower** | Implemented (MVP) | Bank shards at center; tiers 8/18/30 shards; build tower; hold roof zone 20s to win. DepositSystem + TowerSystem; dev cheats: `/teleport`, `/moreshards`, `/tier`. |
| **survival** | Implemented | Wave-based; WaveDirector; win by waves or time; `/killenemy`, `/restart` when ended. |
| **timetrial** | Implemented | Capture objective for 30s; boundary damage if outside safe radius. |
| **bot_ffa, koth, tdm** | Declared in types only | Not implemented. |

**Default mode** in `matchConfig.ts` is `MULTI`. Lobby mode selection is via UI `set_mode` (allowed: MULTI, SOLO, survival, timetrial, tower).

---

## 4. Procedural Arena (Procgen)

- **Spec:** `src/server/procgen/spec.ts` (MapSpecV1: walls, cover, spawn zones, etc.).  
- **Generation:** `generateArenaSpec.ts` (rings, gates, spawn rects), `generateValidArena.ts` (validation + connectivity), `specToMap.ts` + `themes.ts` for block types.  
- **Round start:** RoundController calls `generateValidArena(roundSeed, { size, attempts })` then `specToMap(spec, theme)` and `world.loadMap(map)`. Tower mode injects `TOWER_MATERIAL_IDS` into block types.  
- **Scripts:** `npm run test:procgen`, `npm run test:procgen:build` for smoke/build tests.

---

## 5. Combat & Death

- **CombatService:** Health, melee damage (`MELEE_DAMAGE`), cooldown, knockback, spawn protection (`SPAWN_PROTECTION_MS`).  
- **Death:** On KO, survival mode can end round (lose); tower mode drops carried shards; score attribution (`lastKillerId`). Respawn via RoundController; fall recovery (void Y &lt; -20) with cooldown.  
- **Time trial:** Damage when outside safe radius (throttled).

---

## 6. HUD & UI

- **Server:** HudService builds `HudMessage` from WorldState (shards, health, round status, mode-specific: survival wave/timer, timetrial capture %, tower carried/banked/tier/roof hold).  
- **Client:** `hud.js` maintains local state, handles `hud`, `feed`, `toast`, `roundSplash`; mode-specific UI (tower tier, roof bar, etc.); settings (scale, reduce motion, mute UI sounds) in localStorage.  
- **Schema version:** `HUD_MESSAGE_VERSION` in `hudMessages.ts`; client should tolerate unknown fields.

---

## 7. Bots

- **BotManager:** Spawns bots only when `mode` is MULTI or SOLO (not survival/timetrial). Bots collect shards; on reaching target, `onBotWin` → RoundController.endMatch.  
- **Types:** `src/server/systems/bots/types.ts`; BotBrain for behavior.

---

## 8. Dev / Cheats

- **Docs:** `docs/DEV_CHEATS.md` — `/devcheats`, `/teleport`, `/moreshards`, `/tier`.  
- **Enable:** `PATTERNISLE_DEV_CHEATS=1` or in-game `/devcheats`.  
- **Other:** `/seed`, `/setmatch`, `/forcestart`, `/start`, `/spawnshards`, `/where`, `/round`, `/claim`, `/restart`, `/killenemy`, `/hit`.

---

## 9. Uncommitted / In-Progress (from git status)

- **Modified:** `assets/ui/hud.js`, `index.ts`, `src/server/procgen/generateArenaSpec.ts`, `BotManager.ts`, `DepositSystem.ts`, `RoundController.ts`, `TowerSystem.ts`, `src/server/systems/bots/types.ts`.  
- **New:** `docs/DEV_CHEATS.md`, `assets/models/structures/stairs/oak stairs.gltf` and optimized variant.  

These point to recent work on HUD, tower/deposit flow, procgen, bots, and stairs assets. No README in repo yet.

---

## 10. Technical Debt & Cleanup

- **Deprecated:** `PlayerState.objectivePoints` — use `worldState.score` (Phase 5C); kept for UI/debug until 5D.  
- **RoundManager:** Used for transition callbacks/logging only; RoundController owns timing (no conflicting timers).  
- **MatchMode (types.ts):** `AUTO | SOLO | MULTI` vs `GameMode` in modes/types (includes survival, timetrial, tower, etc.) — naming overlap.

---

## 11. Recommended Next Steps

### Short term (stability & clarity)

1. **Commit or document WIP** — Review diffs in `hud.js`, `RoundController.ts`, `TowerSystem.ts`, `DepositSystem.ts`, `BotManager.ts`, `generateArenaSpec.ts`, and either commit with clear messages or add a short WIP note in `docs/` describing what’s in progress.  
2. **Add a README** — At least: project name, “Hytopia game”, how to run (`npm run build` / Hytopia run), link to `docs/DEV_CHEATS.md` and this synopsis.  
3. **Tower mode playtest** — Use `/devcheats`, `/teleport`, `/moreshards`, `/tier` to verify full tower flow (deposit → tiers → roof hold → win) and fix any bugs.

### Medium term (features & polish)

4. **Finish Phase 5D** — Remove or replace use of `objectivePoints` in UI and switch fully to `worldState.score`; then remove deprecated field.  
5. **Unify mode naming** — Clarify `MatchMode` vs `GameMode` (and any `RoundState.mode`) to avoid confusion and make it obvious which modes are “shard race” vs “solo objective”.  
6. **Survival / Time trial content** — If survival is a priority: more waves, tuning, and/or real NPC enemies (WaveDirector already exists). For timetrial: optional difficulty or time targets.  
7. **Stairs asset** — Integrate `oak stairs.gltf` into tower or structures if desired (e.g. TowerSystem or theme).

### Longer term (scope)

8. **bot_ffa / koth / tdm** — Either implement or remove from `GameMode` so the type reflects reality.  
9. **Persistence** — If you ever need match history or cross-session progress, WorldState is currently in-memory only; design a small persistence layer.  
10. **Testing** — Expand procgen tests; add a few server-side unit tests for RoundController state transitions, score, or tower tier math.

---

## 12. Quick Reference

- **Match config:** `src/server/state/matchConfig.ts` (default mode, size, survival/timetrial params).  
- **Constants:** `TARGET_SHARDS`, `MELEE_DAMAGE`, `SPAWN_PROTECTION_MS` in config/constants.  
- **Arena bounds:** `src/server/config/arenaBounds.ts` (`ARENA_BOUNDS`).  
- **HUD schema:** `src/server/schema/hudMessages.ts`.

Use this doc as the single “where we are” and “what to do next” reference; update it when major features or architecture change.
