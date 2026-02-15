/**
 * Golden Apple objective: server-authoritative spawn, claim (range check), respawn on timer.
 * Event-driven HUD updates only (no per-tick spam).
 */

import type { World, Player } from 'hytopia';
import { PlayerManager } from 'hytopia';
import type { WorldState } from '../state/WorldState.js';
import type { ObjectiveState } from '../state/types.js';
import type { HudService } from '../services/HudService.js';
import type { ScoreService } from '../services/ScoreService.js';

const OBJECTIVE_RESPAWN_MS = 20_000;
const CLAIM_RADIUS = 2.5;

function sqDist(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export class ObjectiveSystem {
  constructor(
    private readonly world: World,
    private readonly worldState: WorldState,
    private readonly hudService: HudService,
    private readonly scoreService: ScoreService
  ) {}

  /** Spawn objective now at a position (fixed center or simple random within safe bounds). Caller broadcasts HUD. */
  spawnObjectiveNow(): void {
    const position = this.pickSpawnPosition();
    const obj: ObjectiveState = {
      id: `objective-${Date.now()}`,
      kind: 'GOLDEN_APPLE',
      position,
      isActive: true,
    };
    this.worldState.objective = obj;
  }

  /** Validate objective active + player in range; if valid: deactivate, schedule respawn, add point, emit HUD events. */
  tryClaim(player: Player): boolean {
    const obj = this.worldState.objective;
    if (!obj || !obj.isActive) return false;

    const playerEntity = this.world.entityManager.getPlayerEntitiesByPlayer(player)[0];
    if (!playerEntity?.isSpawned) return false;

    const playerPos = playerEntity.position;
    const distSq = sqDist(playerPos, obj.position);
    if (distSq > CLAIM_RADIUS * CLAIM_RADIUS) return false;

    const now = Date.now();
    obj.isActive = false;
    obj.claimedByPlayerId = player.id;
    obj.claimedAtMs = now;
    obj.respawnAtMs = now + OBJECTIVE_RESPAWN_MS;

    this.scoreService.addPoint(
      player.id,
      this.getPlayerDisplayName(player.id),
      1,
      'objective'
    );
    this.hudService.toast(player, 'good', 'Golden Apple claimed +1');
    this.hudService.broadcastFeed(
      `${this.getPlayerDisplayName(player.id)} claimed the Golden Apple!`
    );
    this.hudService.broadcastHud();
    return true;
  }

  /** If objective is inactive and now >= respawnAtMs, spawn again. Call at ~250ms interval max. */
  tickRespawn(): void {
    const obj = this.worldState.objective;
    if (!obj || obj.isActive) return;
    const respawnAt = obj.respawnAtMs;
    if (respawnAt == null || Date.now() < respawnAt) return;
    this.spawnObjectiveNow();
  }

  private pickSpawnPosition(): { x: number; y: number; z: number } {
    // Fixed center for now; can later use simple random within safe bounds.
    return { x: 0, y: 10, z: 0 };
  }

  private getPlayerDisplayName(playerId: string): string {
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    const found = players.find((p) => p.id === playerId);
    if (
      found &&
      'name' in found &&
      typeof (found as { name?: string }).name === 'string'
    ) {
      return (found as { name: string }).name;
    }
    return playerId;
  }
}
