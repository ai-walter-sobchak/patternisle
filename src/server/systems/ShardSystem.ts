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

export interface ShardSystemConfig {
  count: number;
  radius: number;
  minSpacing: number;
  pickupRadius: number;
  /** Half-extent of per-player scan box (skip pickups outside this AABB). Defaults to pickupRadius. */
  scanRadius: number;
}

const DEFAULT_CONFIG: ShardSystemConfig = {
  count: 10,
  radius: 20,
  minSpacing: 3,
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
  readonly config: ShardSystemConfig = { ...DEFAULT_CONFIG };
  private spawned = false;
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
    const center = { x: 0, y: 10, z: 0 };
    const { count, radius, minSpacing } = this.config;
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
      const x = center.x + (rng() * 2 - 1) * radius;
      const z = center.z + (rng() * 2 - 1) * radius;
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
      if (state.entity) state.entity.despawn();
    }
    this.pickups.clear();
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

    for (const player of players) {
      const entities = this.world.entityManager.getPlayerEntitiesByPlayer(
        player
      );
      const playerEntity = entities[0];
      if (!playerEntity?.isSpawned) continue;
      const playerPos = playerEntity.position;

      for (const state of this.pickups.values()) {
        if (state.collected) continue;
        if (
          Math.abs(playerPos.x - state.pos.x) > scanRadius ||
          Math.abs(playerPos.y - state.pos.y) > scanRadius ||
          Math.abs(playerPos.z - state.pos.z) > scanRadius
        )
          continue;
        if (sqDist(playerPos, state.pos) > pickupRadiusSq) continue;

        state.collected = true;
        if (state.entity) state.entity.despawn();
        state.entity = undefined;

        const p = this.worldState.getPlayer(player.id);
        if (p) {
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
      }
    }
  }

  getRemainingCount(): number {
    let n = 0;
    for (const s of this.pickups.values()) if (!s.collected) n++;
    return n;
  }
}
