import type { World } from 'hytopia';
import { PlayerManager } from 'hytopia';
import type { WorldState } from '../state/WorldState.js';
import type { HudService } from '../services/HudService.js';
import { hash32 } from '../procgen/themes.js';

const TIER_THRESHOLDS = [8, 18, 30];
const ROOF_HOLD_WIN_MS = 20000;
const TOWER_CENTER_X = 0;
const TOWER_CENTER_Z = 0;
const TOWER_RADIUS = 2;
const ROOF_ZONE_RADIUS = 3;
const TOWER_BLOCK_ID = 15;
const LAYER_ANIMATION_MS = 80;

export interface TowerSpec {
  tier1: { baseY: number; height: number; radius: number };
  tier2: { baseY: number; height: number; radius: number };
  tier3: { baseY: number; height: number; radius: number };
  roofY: number;
}

export type OnTowerWinCallback = (winnerPlayerId: string) => void;

function generateTowerSpec(roundSeed: string): TowerSpec {
  const r = (key: string) => (hash32(roundSeed + key) >>> 0) / 0xffffffff;
  const baseY = 1;
  const height = 3;
  const radius = 2 + Math.floor(r('radius') * 0.5);
  return {
    tier1: { baseY, height, radius },
    tier2: { baseY: baseY + height, height, radius },
    tier3: { baseY: baseY + height * 2, height, radius },
    roofY: baseY + height * 3,
  };
}

function* tierBlocks(
  centerX: number,
  centerZ: number,
  baseY: number,
  height: number,
  radius: number
): Generator<{ x: number; y: number; z: number }> {
  const rSq = radius * radius;
  for (let y = baseY; y < baseY + height; y++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (dx * dx + dz * dz <= rSq) {
          yield { x: centerX + dx, y, z: centerZ + dz };
        }
      }
    }
  }
}

export class TowerSystem {
  private spec: TowerSpec | null = null;
  private lastRoofTickMs = 0;
  private onWin: OnTowerWinCallback | null = null;

  constructor(
    private readonly world: World,
    private readonly worldState: WorldState,
    private readonly hud: HudService
  ) {}

  setOnWinCallback(cb: OnTowerWinCallback): void {
    this.onWin = cb;
  }

  initRound(roundId: number, roundSeed: string): void {
    const seedStr = `${roundSeed}_r${roundId}`;
    this.spec = generateTowerSpec(seedStr);
    const ts = this.worldState.towerState;
    if (ts) {
      ts.unlockedTier = 0;
      ts.roofHoldMs = 0;
      ts.roofActive = false;
    }
  }

  getSpec(): TowerSpec | null {
    return this.spec;
  }

  getTotalBankedShards(): number {
    let total = 0;
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    for (const p of players) {
      const state = this.worldState.getPlayer(p.id);
      if (state) total += state.bankedShards ?? 0;
    }
    return total;
  }

  checkUnlockThresholds(_playerId: string): void {
    if (this.worldState.roundState.status !== 'RUNNING') return;
    const ts = this.worldState.towerState;
    if (!ts) return;

    const banked = this.getTotalBankedShards();
    const current = ts.unlockedTier;

    if (current < 3 && banked >= TIER_THRESHOLDS[current]) {
      const nextTier = (current + 1) as 1 | 2 | 3;
      ts.unlockedTier = nextTier;
      this.buildTier(nextTier);
      this.hud.broadcastToast('good', `Tier ${nextTier} Unlocked`);
      this.hud.broadcastHud();

      if (nextTier === 3) {
        ts.roofActive = true;
      }
    }
  }

  private buildTier(tier: 1 | 2 | 3): void {
    const spec = this.spec;
    if (!spec) return;

    const chunkLattice = this.world.chunkLattice;
    let baseY: number;
    let height: number;
    let radius: number;

    if (tier === 1) {
      baseY = spec.tier1.baseY;
      height = spec.tier1.height;
      radius = spec.tier1.radius;
    } else if (tier === 2) {
      baseY = spec.tier2.baseY;
      height = spec.tier2.height;
      radius = spec.tier2.radius;
    } else {
      baseY = spec.tier3.baseY;
      height = spec.tier3.height;
      radius = spec.tier3.radius;
    }

    const blocks = [...tierBlocks(TOWER_CENTER_X, TOWER_CENTER_Z, baseY, height, radius)];
    const layers = new Map<number, { x: number; y: number; z: number }[]>();
    for (const b of blocks) {
      const list = layers.get(b.y) ?? [];
      list.push(b);
      layers.set(b.y, list);
    }
    const sortedY = [...layers.keys()].sort((a, b) => a - b);

    let delay = 0;
    for (const y of sortedY) {
      const list = layers.get(y)!;
      setTimeout(() => {
        for (const pos of list) {
          chunkLattice.setBlock({ x: pos.x, y: pos.y, z: pos.z }, TOWER_BLOCK_ID);
        }
      }, delay);
      delay += LAYER_ANIMATION_MS;
    }
  }

  getRoofZoneCenter(): { x: number; y: number; z: number } {
    const spec = this.spec;
    const y = spec ? spec.roofY : 10;
    return { x: TOWER_CENTER_X, y, z: TOWER_CENTER_Z };
  }

  isInRoofZone(pos: { x: number; y: number; z: number }): boolean {
    const c = this.getRoofZoneCenter();
    const dx = pos.x - c.x;
    const dz = pos.z - c.z;
    return Math.sqrt(dx * dx + dz * dz) <= ROOF_ZONE_RADIUS;
  }

  tickRoofHold(nowMs: number): void {
    if (this.worldState.roundState.status !== 'RUNNING') return;
    const ts = this.worldState.towerState;
    if (!ts || !ts.roofActive) return;

    const delta = this.lastRoofTickMs ? nowMs - this.lastRoofTickMs : 0;
    this.lastRoofTickMs = nowMs;
    if (delta <= 0) return;

    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    for (const player of players) {
      const entities = this.world.entityManager.getPlayerEntitiesByPlayer(player);
      const entity = entities[0];
      if (!entity?.isSpawned) continue;

      const ps = this.worldState.getPlayer(player.id);
      if (!ps || (ps.health ?? 0) <= 0) continue;

      const pos = entity.position;
      if (!this.isInRoofZone(pos)) continue;

      ts.roofHoldMs += delta;
      if (ts.roofHoldMs >= ROOF_HOLD_WIN_MS) {
        this.onWin?.(player.id);
        return;
      }
    }

    this.hud.broadcastHud();
  }
}
