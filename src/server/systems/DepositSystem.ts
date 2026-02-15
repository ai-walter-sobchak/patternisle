import type { World } from 'hytopia';
import { Entity, PlayerManager } from 'hytopia';
import { ColliderShape, RigidBodyType } from 'hytopia';
import type { WorldState } from '../state/WorldState.js';
import type { HudService } from '../services/HudService.js';
import type { TowerSystem } from './TowerSystem.js';

const CONSOLE_CENTER_X = 0;
const CONSOLE_CENTER_Z = 0;
const CONSOLE_RADIUS = 3;

const ZONE_HALF_EXTENTS = { x: 3, y: 0.08, z: 3 };
const ZONE_EMISSIVE_COLOR = { r: 0.3, g: 0.85, b: 1 };
const ZONE_EMISSIVE_INTENSITY = 4;
const ZONE_OUTLINE_COLOR = { r: 0.4, g: 0.9, b: 1 };
const ZONE_OUTLINE_INTENSITY = 2.5;

export class DepositSystem {
  private consoleY: number = 0;
  /** When set (e.g. tower mode), deposit zone is at this position instead of (0, consoleY, 0). */
  private consolePosition: { x: number; y: number; z: number } | null = null;
  private zoneEntity: Entity | null = null;
  private wasInZoneByPlayer: Map<string, boolean> = new Map();

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

  /** Set full position (e.g. beside tower); clears when set to null. */
  setConsolePosition(x: number, y: number, z: number): void {
    this.consolePosition = { x, y, z };
  }

  clearConsolePosition(): void {
    this.consolePosition = null;
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
    if (this.consolePosition) return this.consolePosition;
    return { x: CONSOLE_CENTER_X, y: this.consoleY, z: CONSOLE_CENTER_Z };
  }

  cancelDeposit(_playerId: string): void {}

  isPlayerInConsoleRange(pos: { x: number; y: number; z: number }): boolean {
    const c = this.getConsolePosition();
    const dx = pos.x - c.x;
    const dz = pos.z - c.z;
    return Math.sqrt(dx * dx + dz * dz) <= CONSOLE_RADIUS;
  }

  tick(_nowMs: number): void {
    if (this.worldState.roundState.status !== 'RUNNING') return;
    if (this.worldState.matchConfig.mode !== 'tower') return;

    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    for (const player of players) {
      const entities = this.world.entityManager.getPlayerEntitiesByPlayer(player);
      const entity = entities[0];
      if (!entity?.isSpawned) continue;

      const pos = entity.position;
      const inZone = this.isPlayerInConsoleRange(pos);
      const wasInZone = this.wasInZoneByPlayer.get(player.id) ?? false;

      if (!inZone) {
        this.wasInZoneByPlayer.set(player.id, false);
        continue;
      }

      this.wasInZoneByPlayer.set(player.id, true);
      if (wasInZone) continue;

      const ps = this.worldState.getPlayer(player.id);
      if (!ps) continue;
      const carried = ps.carriedShards ?? 0;
      if (carried <= 0) continue;

      ps.bankedShards = (ps.bankedShards ?? 0) + carried;
      ps.carriedShards = 0;

      this.hud.broadcastHud();
      this.hud.broadcastToast('good', `Deposited ${carried} shards`);
      this.towerSystem?.checkUnlockThresholds(player.id);
    }
  }
}
