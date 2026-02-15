/**
 * Shard pickup system: deterministic spawn once per match, proximity auto-pickup.
 * Server-authoritative; anti-dupe; multiplayer-safe (pickup disappears for everyone when collected).
 */

import type { World } from 'hytopia';
import { PlayerManager } from 'hytopia';
import { createDeterministicRng } from '../utils/deterministicRng.js';
import type { ShardPickupState } from '../entities/ShardPickup.js';
import { createShardPickupEntity } from '../entities/ShardPickup.js';
import type { WorldState } from '../state/WorldState.js';
import type { HudService } from '../services/HudService.js';
import { ARENA_BOUNDS } from '../config/arenaBounds.js';
import { sampleRingPosition } from '../procgen/ringSpawnPositions.js';

export interface ShardSystemConfig {
  count: number;
  radius: number;
  minSpacing: number;
  pickupRadius: number;
  /** Half-extent of per-player scan box (skip pickups outside this AABB). Defaults to pickupRadius. */
  scanRadius: number;
}

const DEFAULT_CONFIG: ShardSystemConfig = {
  count: 45,
  radius: 20,
  minSpacing: 4,
  pickupRadius: 2.5,
  scanRadius: 2.5,
};

function sqDist(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export interface ShardSystemOptions {
  /** Called when a player collects shards (after WorldState is updated). */
  onShardsAwarded?: (playerId: string) => void;
  /** If set, send HUD + feed (+ optional toast) on pickup. */
  hud?: HudService;
}

export class ShardSystem {
  readonly pickups: Map<string, ShardPickupState> = new Map();
  readonly droppedPickups: Map<string, ShardPickupState> = new Map();
  readonly config: ShardSystemConfig = { ...DEFAULT_CONFIG };
  private spawned = false;
  private droppedIdSeq = 0;
  private readonly onShardsAwarded?: (playerId: string) => void;
  private readonly hud?: HudService;

  constructor(
    private readonly world: World,
    private readonly worldState: WorldState,
    options: ShardSystemOptions = {}
  ) {
    this.onShardsAwarded = options.onShardsAwarded;
    this.hud = options.hud;
  }

  /**
   * Generate positions from seed and spawn pickup entities once per match.
   * Safe to call again only if DEV_MODE and /spawnshards (clears existing first).
   */
  generateAndSpawnPickups(seed: number): void {
    if (this.spawned) return;
    this.spawned = true;

    const rng = createDeterministicRng(seed);
    const { count, minSpacing } = this.config;
    const spec = this.worldState.procgenSpec;
    const { minX, maxX, minZ, maxZ } = ARENA_BOUNDS;
    const minSq = minSpacing * minSpacing;
    const positions: { x: number; y: number; z: number }[] = [];
    const maxAttempts = count * 200;
    let attempts = 0;

    const RAYCAST_START_Y = 100;
    const RAYCAST_LENGTH = 150;
    const GROUND_OFFSET = 0.6;
    const FALLBACK_Y = 2;
    const DOWN = { x: 0, y: -1, z: 0 };

    while (positions.length < count && attempts < maxAttempts) {
      attempts++;
      let x: number;
      let z: number;
      if (spec) {
        const p = sampleRingPosition(spec, rng);
        x = p.x;
        z = p.z;
      } else {
        x = minX + rng() * (maxX - minX);
        z = minZ + rng() * (maxZ - minZ);
      }
      rng(); // keep RNG sequence unchanged (was used for y)
      const origin = { x, y: RAYCAST_START_Y, z };
      const hit = this.world.simulation.raycast(
        origin,
        DOWN,
        RAYCAST_LENGTH
      );
      const y = hit ? hit.hitPoint.y + GROUND_OFFSET : FALLBACK_Y;
      const pos = { x, y, z };

      const tooClose = positions.some(p => sqDist(p, pos) < minSq);
      if (tooClose) continue;

      positions.push(pos);
    }

    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      const value = 1 + Math.floor(rng() * 5);
      const id = `shard-${i}`; // deterministic for replication/debugging
      const entity = createShardPickupEntity(this.world, pos);
      const state: ShardPickupState = {
        id,
        pos: { ...pos },
        value,
        collected: false,
        entity,
      };
      this.pickups.set(id, state);
    }
  }

  /**
   * Reset shards for a new match: clear state, rebuild placements with optional seed, spawn entities.
   * Call from RoundController.startMatch() so every round (e.g. Round 2) has shards again.
   */
  resetForNewMatch(seed?: number): void {
    this.clearPickups();
    this.spawned = false;
    const usedSeed = seed ?? this.worldState.seed;
    this.generateAndSpawnPickups(usedSeed);
    const remaining = this.getRemainingCount();
    console.log('[shards] resetForNewMatch', { seed: usedSeed, remaining });
  }

  /**
   * Regenerate and spawn pickups (clears existing). For DEV_MODE only.
   * Despawns any existing entities, clears the map, resets spawned flag so repeated calls do not leak entities.
   */
  regeneratePickups(seed: number): void {
    this.clearPickups();
    this.spawned = false;
    this.generateAndSpawnPickups(seed);
  }

  private clearPickups(): void {
    for (const state of this.pickups.values()) {
      if (state.entity?.isSpawned) state.entity.despawn();
    }
    this.pickups.clear();
    for (const state of this.droppedPickups.values()) {
      if (state.entity?.isSpawned) state.entity.despawn();
    }
    this.droppedPickups.clear();
  }

  /**
   * Tower MVP: spawn physical shard pickups at position (e.g. on death). Each has value 1.
   */
  spawnDroppedShards(centerPos: { x: number; y: number; z: number }, count: number): void {
    for (let i = 0; i < count; i++) {
      const offset = 0.6 * (i % 5 - 2);
      const pos = {
        x: centerPos.x + (i % 3) * 0.5 - 0.5,
        y: centerPos.y,
        z: centerPos.z + offset,
      };
      const id = `dropped-${Date.now()}-${this.droppedIdSeq++}`;
      const entity = createShardPickupEntity(this.world, pos);
      const state: ShardPickupState = {
        id,
        pos: { ...pos },
        value: 1,
        collected: false,
        entity,
      };
      this.droppedPickups.set(id, state);
    }
  }

  /**
   * Per-tick: proximity check for all connected players; collect once, despawn, update WorldState, chat.
   * Uses a cheap AABB early-out (scanRadius) so we only run sqDist for pickups inside the player's scan box.
   */
  tick(_dtMs: number): void {
    const players = PlayerManager.instance.getConnectedPlayersByWorld(
      this.world
    );
    const pickupRadiusSq = this.config.pickupRadius * this.config.pickupRadius;
    const scanRadius = this.config.scanRadius;
    const isTower = this.worldState.matchConfig.mode === 'tower';

    for (const player of players) {
      const entities = this.world.entityManager.getPlayerEntitiesByPlayer(
        player
      );
      const playerEntity = entities[0];
      if (!playerEntity?.isSpawned) continue;
      const playerPos = playerEntity.position;

      const tryCollect = (state: ShardPickupState, isDropped: boolean) => {
        if (state.collected) return;
        const pickupPos = state.entity?.position ?? state.pos;
        if (
          Math.abs(playerPos.x - pickupPos.x) > scanRadius ||
          Math.abs(playerPos.y - pickupPos.y) > scanRadius ||
          Math.abs(playerPos.z - pickupPos.z) > scanRadius
        )
          return;
        if (sqDist(playerPos, pickupPos) > pickupRadiusSq) return;

        const entityToDespawn = state.entity;
        if (entityToDespawn?.isSpawned) entityToDespawn.despawn();
        state.collected = true;
        state.entity = undefined;

        const p = this.worldState.getPlayer(player.id);
        if (!p) return;

        if (isTower) {
          p.carriedShards = (p.carriedShards ?? 0) + state.value;
          this.hud?.sendHud(player);
          this.hud?.feed(player, `+${state.value} shards`);
          this.hud?.toast(player, 'good', `+${state.value} shards`);
        } else {
          p.shards += state.value;
          const total = p.shards;
          this.hud?.sendHud(player);
          this.hud?.feed(player, `+${state.value} shards`);
          this.hud?.toast(player, 'good', `+${state.value} shards`);
          this.world.chatManager.sendPlayerMessage(
            player,
            `+${state.value} shards (total ${total})`,
            '00FF00'
          );
          this.onShardsAwarded?.(player.id);
        }
      };

      for (const state of this.pickups.values()) tryCollect(state, false);
      for (const state of this.droppedPickups.values()) {
        tryCollect(state, false);
        if (state.collected) this.droppedPickups.delete(state.id);
      }
    }
  }

  /** Bots use a larger pickup radius so they collect reliably (they move in 1-unit steps). */
  private static readonly BOT_PICKUP_RADIUS = 4;
  private static readonly BOT_SCAN_RADIUS = 5;

  /**
   * Try to collect a shard at the given position for a bot. Server-authoritative.
   * Returns true if a pickup was collected and bot state was updated.
   */
  tryCollectForBot(botId: string, position: { x: number; y: number; z: number }): boolean {
    const pickupRadiusSq = ShardSystem.BOT_PICKUP_RADIUS * ShardSystem.BOT_PICKUP_RADIUS;
    const scanRadius = ShardSystem.BOT_SCAN_RADIUS;

    for (const state of this.pickups.values()) {
      if (state.collected) continue;
      const pickupPos = state.entity?.isSpawned ? state.entity.position : state.pos;
      if (
        Math.abs(position.x - pickupPos.x) > scanRadius ||
        Math.abs(position.y - pickupPos.y) > scanRadius ||
        Math.abs(position.z - pickupPos.z) > scanRadius
      )
        continue;
      if (sqDist(position, pickupPos) > pickupRadiusSq) continue;

      const entityToDespawn = state.entity;
      if (entityToDespawn?.isSpawned) entityToDespawn.despawn();
      state.collected = true;
      state.entity = undefined;

      const p = this.worldState.getPlayer(botId);
      if (p) {
        p.shards += state.value;
        this.onShardsAwarded?.(botId);
      }
      return true;
    }
    return false;
  }

  getRemainingCount(): number {
    let n = 0;
    for (const s of this.pickups.values()) if (!s.collected) n++;
    return n;
  }
}
