import type { World } from 'hytopia';
import { Entity, PlayerManager } from 'hytopia';
import { ColliderShape, RigidBodyType } from 'hytopia';
import type { WorldState } from '../state/WorldState.js';
import type { HudService } from '../services/HudService.js';
import type { TowerSystem } from './TowerSystem.js';

const CONSOLE_CENTER_X = 0;
const CONSOLE_CENTER_Z = 0;
const CONSOLE_RADIUS = 3;
const DEPOSIT_HOLD_MS = 1500;
const MOVE_CANCEL_THRESHOLD = 1.5;

const ZONE_HALF_EXTENTS = { x: 3, y: 0.08, z: 3 };
const ZONE_EMISSIVE_COLOR = { r: 0.3, g: 0.85, b: 1 };
const ZONE_EMISSIVE_INTENSITY = 4;
const ZONE_OUTLINE_COLOR = { r: 0.4, g: 0.9, b: 1 };
const ZONE_OUTLINE_INTENSITY = 2.5;

interface ActiveDeposit {
  playerId: string;
  startMs: number;
  startPos: { x: number; y: number; z: number };
}

export class DepositSystem {
  private activeDeposit: ActiveDeposit | null = null;
  private consoleY: number = 0;
  private zoneEntity: Entity | null = null;

  constructor(
    private readonly world: World,
    private readonly worldState: WorldState,
    private readonly hud: HudService,
    private towerSystem: TowerSystem | null
  ) {}

  setTowerSystem(system: TowerSystem): void {
    this.towerSystem = system;
  }

  setConsoleY(y: number): void {
    this.consoleY = y;
  }

  despawnZoneMarker(): void {
    if (this.zoneEntity?.isSpawned) {
      this.zoneEntity.despawn();
    }
    this.zoneEntity = null;
  }

  spawnZoneMarker(): void {
    this.despawnZoneMarker();
    const pos = this.getConsolePosition();
    const y = pos.y + ZONE_HALF_EXTENTS.y;
    const entity = new Entity({
      name: 'DepositZone',
      isEnvironmental: true,
      blockTextureUri: 'blocks/coal-ore.png',
      blockHalfExtents: ZONE_HALF_EXTENTS,
      emissiveColor: ZONE_EMISSIVE_COLOR,
      emissiveIntensity: ZONE_EMISSIVE_INTENSITY,
      outline: {
        color: ZONE_OUTLINE_COLOR,
        colorIntensity: ZONE_OUTLINE_INTENSITY,
        thickness: 0.06,
        opacity: 1,
        occluded: false,
      },
      rigidBodyOptions: {
        type: RigidBodyType.FIXED,
        colliders: [{ shape: ColliderShape.BLOCK, halfExtents: ZONE_HALF_EXTENTS }],
      },
    });
    entity.spawn(this.world, { x: pos.x, y, z: pos.z });
    this.zoneEntity = entity;
  }

  getConsolePosition(): { x: number; y: number; z: number } {
    return { x: CONSOLE_CENTER_X, y: this.consoleY, z: CONSOLE_CENTER_Z };
  }

  isPlayerInConsoleRange(pos: { x: number; y: number; z: number }): boolean {
    const c = this.getConsolePosition();
    const dx = pos.x - c.x;
    const dz = pos.z - c.z;
    return Math.sqrt(dx * dx + dz * dz) <= CONSOLE_RADIUS;
  }

  startDeposit(playerId: string): boolean {
    if (this.worldState.roundState.status !== 'RUNNING') return false;
    if (this.worldState.matchConfig.mode !== 'tower') return false;
    if (this.activeDeposit) return false;

    const player = PlayerManager.instance.getConnectedPlayersByWorld(this.world).find((p) => p.id === playerId);
    if (!player) return false;

    const entities = this.world.entityManager.getPlayerEntitiesByPlayer(player);
    const entity = entities[0];
    if (!entity?.isSpawned) return false;

    const pos = entity.position;
    if (!this.isPlayerInConsoleRange(pos)) return false;

    const p = this.worldState.getPlayer(playerId);
    if (!p || (p.carriedShards ?? 0) <= 0) return false;

    this.activeDeposit = {
      playerId,
      startMs: Date.now(),
      startPos: { x: pos.x, y: pos.y, z: pos.z },
    };
    return true;
  }

  endDeposit(playerId: string): void {
    if (this.activeDeposit?.playerId === playerId) {
      this.activeDeposit = null;
    }
  }

  cancelDeposit(playerId: string): void {
    if (this.activeDeposit?.playerId === playerId) {
      this.activeDeposit = null;
    }
  }

  tick(nowMs: number): void {
    if (!this.activeDeposit) return;
    if (this.worldState.roundState.status !== 'RUNNING') {
      this.activeDeposit = null;
      return;
    }

    const { playerId, startMs, startPos } = this.activeDeposit;
    const player = PlayerManager.instance.getConnectedPlayersByWorld(this.world).find((p) => p.id === playerId);
    if (!player) {
      this.activeDeposit = null;
      return;
    }

    const entities = this.world.entityManager.getPlayerEntitiesByPlayer(player);
    const entity = entities[0];
    if (!entity?.isSpawned) {
      this.activeDeposit = null;
      return;
    }

    const pos = entity.position;
    const dx = pos.x - startPos.x;
    const dy = pos.y - startPos.y;
    const dz = pos.z - startPos.z;
    if (dx * dx + dy * dy + dz * dz > MOVE_CANCEL_THRESHOLD * MOVE_CANCEL_THRESHOLD) {
      this.activeDeposit = null;
      return;
    }

    if (!this.isPlayerInConsoleRange(pos)) {
      this.activeDeposit = null;
      return;
    }

    if (nowMs - startMs < DEPOSIT_HOLD_MS) return;

    const ps = this.worldState.getPlayer(playerId);
    if (!ps) {
      this.activeDeposit = null;
      return;
    }

    const carried = ps.carriedShards ?? 0;
    if (carried <= 0) {
      this.activeDeposit = null;
      return;
    }

    ps.bankedShards = (ps.bankedShards ?? 0) + carried;
    ps.carriedShards = 0;

    this.activeDeposit = null;

    this.hud.broadcastHud();
    this.hud.broadcastToast('good', `Deposited ${carried} shards`);
    this.towerSystem?.checkUnlockThresholds(playerId);
  }
}
