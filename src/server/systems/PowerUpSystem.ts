/**
 * Server-authoritative ambient power-ups. Spawns visible entities; maintains up to maxActive.
 * Tick handles effect expiry and respawn; tryPickup despawns entity on collect.
 */

import type { World, Player } from 'hytopia';
import { PlayerManager } from 'hytopia';
import type { Entity } from 'hytopia';
import type { WorldState } from '../state/WorldState.js';
import type { SpawnSystem } from './SpawnSystem.js';
import type { HudService } from '../services/HudService.js';
import type {
  PowerUpKind,
  PowerUpSpawn,
  ActiveEffect,
} from '../state/types.js';
import { ARENA_BOUNDS } from '../config/arenaBounds.js';
import { createPowerUpPickupEntity } from '../entities/PowerUpPickup.js';

const PICKUP_RADIUS = 2.5;
const PICKUP_RADIUS_SQ = PICKUP_RADIUS * PICKUP_RADIUS;
const TICK_THROTTLE_MS = 200;

/** Only these two power-ups are active for now: emerald = speed, diamond = jump. */
const POWERUP_KINDS: PowerUpKind[] = ['SPEED', 'JUMP'];

const EFFECT_DURATION_MS: Record<Exclude<PowerUpKind, 'HEAL'>, number> = {
  SPEED: 8000,
  JUMP: 8000,
  SHIELD: 6000,
  MAGNET: 8000,
  DOUBLE_AMBIENT: 10000,
};

const HEAL_AMOUNT = 25;
const MAX_HEALTH = 100;

const RAYCAST_START_Y = 100;
const RAYCAST_LENGTH = 150;
const GROUND_OFFSET = 0.6;
const FALLBACK_Y = 2;

function sqDist(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomKind(): PowerUpKind {
  return POWERUP_KINDS[Math.floor(Math.random() * POWERUP_KINDS.length)];
}

function resolveGroundPosition(
  world: World,
  pos: { x: number; y: number; z: number }
): { x: number; y: number; z: number } {
  const origin = { x: pos.x, y: RAYCAST_START_Y, z: pos.z };
  const direction = { x: 0, y: -1, z: 0 };
  const hit = world.simulation.raycast(origin, direction, RAYCAST_LENGTH);
  const y = hit ? hit.hitPoint.y + GROUND_OFFSET : FALLBACK_Y;
  return { x: pos.x, y, z: pos.z };
}

export class PowerUpSystem {
  private spawnIdCounter = 0;
  /** Active world entities for each spawn id; despawn when collected. */
  private readonly entitiesBySpawnId = new Map<string, Entity>();

  constructor(
    private readonly world: World,
    private readonly worldState: WorldState,
    private readonly spawnSystem: SpawnSystem,
    private readonly hud: HudService
  ) {}

  /**
   * Create count spawn records at reasonable positions and spawn visible entities.
   * Marks isActive = true.
   */
  seedInitialSpawns(count: number): void {
    const { powerUps } = this.worldState;
    const positions = this.getSpawnPositions(count);

    for (let i = 0; i < count; i++) {
      const id = `pu-${Date.now()}-${++this.spawnIdCounter}`;
      const kind = randomKind();
      const position = resolveGroundPosition(this.world, positions[i]);
      const entity = createPowerUpPickupEntity(this.world, position, kind);
      this.entitiesBySpawnId.set(id, entity);
      const spawn: PowerUpSpawn = {
        id,
        kind,
        position: { ...position },
        isActive: true,
      };
      powerUps.spawnsById[id] = spawn;
    }
  }

  /**
   * Throttled tick: only when RUNNING; expire effects, maintain active spawn count.
   */
  tick(): void {
    const now = Date.now();
    const { powerUps, roundState } = this.worldState;

    if (roundState.status !== 'RUNNING') return;
    if (powerUps.lastTickAtMs != null && now - powerUps.lastTickAtMs < TICK_THROTTLE_MS) return;
    powerUps.lastTickAtMs = now;

    this.expireEffects(now);
    this.maintainActiveSpawns(now);
  }

  /**
   * Check if player is within PICKUP_RADIUS of any active spawn; if so, apply effect and deactivate.
   */
  tryPickup(player: Player): void {
    const { powerUps, roundState } = this.worldState;
    if (roundState.status !== 'RUNNING') return;

    const entities = this.world.entityManager.getPlayerEntitiesByPlayer(player);
    const entity = entities[0];
    if (!entity?.isSpawned) return;

    const pos = entity.position;
    const playerPos = { x: pos.x, y: pos.y, z: pos.z };

    for (const spawn of Object.values(powerUps.spawnsById)) {
      if (!spawn.isActive) continue;
      if (sqDist(spawn.position, playerPos) > PICKUP_RADIUS_SQ) continue;

      this.applyEffect(player.id, spawn.kind);
      spawn.isActive = false;
      const now = Date.now();
      const respawnMin = powerUps.respawnMinMs;
      const respawnMax = powerUps.respawnMaxMs;
      spawn.respawnAtMs = now + randomInRange(respawnMin, respawnMax);

      const pickupEntity = this.entitiesBySpawnId.get(spawn.id);
      if (pickupEntity?.isSpawned) {
        pickupEntity.despawn();
        this.entitiesBySpawnId.delete(spawn.id);
      }

      const kindLabel = spawn.kind.replace(/_/g, ' ');
      this.hud.toast(player, 'good', `${kindLabel} picked up`);
      this.hud.broadcastFeed(`${this.getPlayerDisplayName(player.id)} got ${kindLabel}`);
      this.hud.broadcastHud();
      return;
    }
  }

  /**
   * Add or update effect on player. HEAL is immediate (+25 hp, cap 100); others get duration.
   */
  applyEffect(playerId: string, kind: PowerUpKind): void {
    const player = this.worldState.getPlayer(playerId);
    if (!player) return;

    if (kind === 'HEAL') {
      player.health = Math.min(MAX_HEALTH, (player.health ?? 100) + HEAL_AMOUNT);
      const connected = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
      const p = connected.find((pl) => pl.id === playerId);
      if (p) this.hud.sendHud(p);
      return;
    }

    const durationMs = EFFECT_DURATION_MS[kind];
    const expiresAtMs = Date.now() + durationMs;

    if (!player.effects) player.effects = [];
    const existing = player.effects.findIndex((e) => e.kind === kind);
    const entry: ActiveEffect = { kind, expiresAtMs };
    if (existing >= 0) {
      player.effects[existing] = entry;
    } else {
      player.effects.push(entry);
    }

    const connected = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    const pl = connected.find((p) => p.id === playerId);
    if (pl) this.hud.sendHud(pl);
  }

  /**
   * Award ambient score; doubled if player has DOUBLE_AMBIENT. Updates HUD.
   */
  awardAmbient(playerId: string, base: number = 1): void {
    const player = this.worldState.getPlayer(playerId);
    if (!player) return;

    const hasDouble = (player.effects ?? []).some((e) => e.kind === 'DOUBLE_AMBIENT');
    const mult = hasDouble ? 2 : 1;
    const prev = player.ambientScore ?? 0;
    player.ambientScore = prev + base * mult;

    const connected = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    const pl = connected.find((p) => p.id === playerId);
    if (pl) this.hud.sendHud(pl);
  }

  private getSpawnPositions(count: number): Array<{ x: number; y: number; z: number }> {
    const points = this.worldState.spawn.spawnPoints;
    if (points.length >= count) {
      const indices = new Set<number>();
      while (indices.size < count) {
        indices.add(Math.floor(Math.random() * points.length));
      }
      return Array.from(indices).map((i) => ({ ...points[i] }));
    }
    const out: Array<{ x: number; y: number; z: number }> = [];
    const { minX, maxX, minZ, maxZ, y } = ARENA_BOUNDS;
    for (let i = 0; i < count; i++) {
      out.push({
        x: randomInRange(minX, maxX),
        y,
        z: randomInRange(minZ, maxZ),
      });
    }
    return out;
  }

  private expireEffects(now: number): void {
    const connected = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    for (const player of connected) {
      const ps = this.worldState.getPlayer(player.id);
      if (!ps?.effects?.length) continue;
      const before = ps.effects!.length;
      ps.effects = ps.effects!.filter((e) => e.expiresAtMs > now);
      if (ps.effects.length !== before) this.hud.sendHud(player);
    }
  }

  private maintainActiveSpawns(now: number): void {
    const { powerUps } = this.worldState;
    const spawns = Object.values(powerUps.spawnsById);
    const activeCount = spawns.filter((s) => s.isActive).length;
    if (activeCount >= powerUps.maxActive) return;

    const needed = powerUps.maxActive - activeCount;
    const readyToRespawn = spawns
      .filter((s) => !s.isActive && s.respawnAtMs != null && s.respawnAtMs <= now)
      .sort((a, b) => (a.respawnAtMs ?? 0) - (b.respawnAtMs ?? 0));

    let activated = 0;
    for (const spawn of readyToRespawn) {
      if (activated >= needed) break;
      spawn.isActive = true;
      spawn.respawnAtMs = undefined;
      spawn.kind = randomKind();
      const position = resolveGroundPosition(this.world, spawn.position);
      spawn.position = { ...position };
      const entity = createPowerUpPickupEntity(this.world, position, spawn.kind);
      this.entitiesBySpawnId.set(spawn.id, entity);
      activated++;
    }

    const stillNeeded = needed - activated;
    if (stillNeeded <= 0) return;

    const positions = this.getSpawnPositions(stillNeeded);
    for (let i = 0; i < stillNeeded; i++) {
      const id = `pu-${Date.now()}-${++this.spawnIdCounter}`;
      const kind = randomKind();
      const position = resolveGroundPosition(this.world, positions[i]);
      const entity = createPowerUpPickupEntity(this.world, position, kind);
      this.entitiesBySpawnId.set(id, entity);
      powerUps.spawnsById[id] = {
        id,
        kind,
        position: { ...position },
        isActive: true,
      };
    }
  }

  private getPlayerDisplayName(playerId: string): string {
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    const found = players.find((p) => p.id === playerId);
    if (found && 'name' in found && typeof (found as { name?: string }).name === 'string') {
      return (found as { name: string }).name;
    }
    return playerId;
  }
}
