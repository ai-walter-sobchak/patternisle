import type { World } from 'hytopia';
import { PlayerManager } from 'hytopia';
import type { WorldState } from '../state/WorldState.js';
import type { HudService } from '../services/HudService.js';
import { hash32 } from '../procgen/themes.js';

const TIER_THRESHOLDS = [8, 18, 30];
const AIR_BLOCK_ID = 0;
/** Block IDs used for tower (must be included in map blockTypes when in tower mode). */
export const TOWER_MATERIAL_IDS = [1, 3, 5, 15];
const ROOF_HOLD_WIN_MS = 20000;
const TOWER_CENTER_X = 0;
const TOWER_CENTER_Z = 0;
const ROOF_ZONE_RADIUS = 6;
/** Bounding box for tower clear so the whole area is reset each round (x/z extent, y max). */
const TOWER_CLEAR_RADIUS = 14;
const TOWER_CLEAR_Y_MAX = 32;

export interface TowerSpec {
  materialTier1: number;
  materialTier2: number;
  materialTier3: number;
  materialStairs: number;
  landingY1: number;
  landingY2: number;
  landingY3: number;
  roofY: number;
  radius1: number;
  radius2: number;
  radius3: number;
  stairAxis: 'z' | 'x';
  /** Spiral: 1 = counter-clockwise (angle increases), -1 = clockwise */
  spiralDirection: 1 | -1;
  /** Start angle in radians (around tower center) */
  spiralAngleStart: number;
}

export type OnTowerWinCallback = (winnerPlayerId: string) => void;

function pickMaterial(seed: string, key: string): number {
  const h = hash32(seed + key);
  return TOWER_MATERIAL_IDS[h % TOWER_MATERIAL_IDS.length];
}

function generateTowerSpec(roundSeed: string): TowerSpec {
  const r = (key: string) => (hash32(roundSeed + key) >>> 0) / 0xffffffff;
  const baseY = 1;
  const landingY1 = baseY + 4;
  const landingY2 = baseY + 12;
  const landingY3 = baseY + 20;
  const roofY = baseY + 28;

  let m1 = pickMaterial(roundSeed, 't1');
  let m2 = pickMaterial(roundSeed, 't2');
  let m3 = pickMaterial(roundSeed, 't3');
  while (m2 === m1) m2 = pickMaterial(roundSeed, 't2_' + m2);
  while (m3 === m1 || m3 === m2) m3 = pickMaterial(roundSeed, 't3_' + m3);
  const materialStairs = pickMaterial(roundSeed, 'stairs');

  const radius1 = 5 + Math.floor(r('r1') * 3);
  const radius2 = 8 + Math.floor(r('r2') * 2);
  const radius3 = 8 + Math.floor(r('r3') * 2);
  const stairAxis = r('axis') < 0.5 ? 'z' : 'x';
  const spiralDirection = (r('spiral') < 0.5 ? 1 : -1) as 1 | -1;
  const spiralAngleStart = r('angle') * 2 * Math.PI;

  return {
    materialTier1: m1,
    materialTier2: m2,
    materialTier3: m3,
    materialStairs,
    landingY1,
    landingY2,
    landingY3,
    roofY,
    radius1,
    radius2,
    radius3,
    stairAxis,
    spiralDirection,
    spiralAngleStart,
  };
}

function* landingBlocks(
  cx: number,
  cz: number,
  y: number,
  radius: number
): Generator<{ x: number; y: number; z: number }> {
  const rSq = radius * radius;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (dx * dx + dz * dz <= rSq) {
        yield { x: cx + dx, y, z: cz + dz };
      }
    }
  }
}

/** Width of each straight stair run (blocks). */
const STAIR_WIDTH = 5;

/** Straight stair blocks from lower landing edge to upper landing edge (one run per side). */
function* stairBlocks(
  cx: number,
  cz: number,
  yStart: number,
  yEnd: number,
  prevRadius: number,
  landingRadius: number,
  axis: 'z' | 'x',
  sign: 1 | -1
): Generator<{ x: number; y: number; z: number }> {
  const steps = yEnd - yStart;
  const half = Math.floor(STAIR_WIDTH / 2);
  for (let i = 0; i <= steps; i++) {
    const y = yStart + i;
    const t = steps > 0 ? prevRadius + Math.round(((landingRadius - prevRadius) * i) / steps) : landingRadius;
    if (axis === 'z') {
      const z = cz + sign * t;
      for (let w = -half; w <= half; w++) yield { x: cx + w, y, z };
    } else {
      const x = cx + sign * t;
      for (let w = -half; w <= half; w++) yield { x, y, z: cz + w };
    }
  }
}

export class TowerSystem {
  private spec: TowerSpec | null = null;
  private lastRoofTickMs = 0;
  private onWin: OnTowerWinCallback | null = null;
  /** All block positions we placed (landings + stairs + roof); cleared on initRound. */
  private towerBlockPositions: { x: number; y: number; z: number }[] = [];

  constructor(
    private readonly world: World,
    private readonly worldState: WorldState,
    private readonly hud: HudService
  ) {}

  setOnWinCallback(cb: OnTowerWinCallback): void {
    this.onWin = cb;
  }

  /** Call before loading the next map so the previous round's tower is cleared to nothing. */
  clearTowerForNewRound(): void {
    const chunkLattice = this.world.chunkLattice;
    for (const pos of this.towerBlockPositions) {
      chunkLattice.setBlock({ x: pos.x, y: pos.y, z: pos.z }, AIR_BLOCK_ID);
    }
    this.towerBlockPositions = [];
    for (let x = -TOWER_CLEAR_RADIUS; x <= TOWER_CLEAR_RADIUS; x++) {
      for (let z = -TOWER_CLEAR_RADIUS; z <= TOWER_CLEAR_RADIUS; z++) {
        for (let y = 0; y <= TOWER_CLEAR_Y_MAX; y++) {
          chunkLattice.setBlock({ x, y, z }, AIR_BLOCK_ID);
        }
      }
    }
  }

  initRound(roundId: number, roundSeed: string): void {
    this.towerBlockPositions = [];
    const seedStr = `${roundSeed}_r${roundId}`;
    this.spec = generateTowerSpec(seedStr);
    const ts = this.worldState.towerState;
    if (ts) {
      ts.unlockedTier = 0;
      ts.roofHoldMs = 0;
      ts.roofActive = false;
    }
    // Build tier 1 at round start so the base + stairs to first landing are visible immediately
    this.buildTier(1);
    if (ts) ts.unlockedTier = 1;
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

  unlockAndBuildNextTier(): boolean {
    if (this.worldState.matchConfig.mode !== 'tower') return false;
    const ts = this.worldState.towerState;
    if (!ts || !this.spec) return false;
    const current = ts.unlockedTier;
    if (current >= 3) return false;

    const nextTier = (current + 1) as 1 | 2 | 3;
    ts.unlockedTier = nextTier;
    this.buildTier(nextTier);
    this.hud.broadcastToast('good', `Tier ${nextTier} Unlocked`);
    this.hud.broadcastHud();
    if (nextTier === 3) ts.roofActive = true;
    return true;
  }

  private buildTier(tier: 1 | 2 | 3): void {
    const spec = this.spec;
    if (!spec) return;

    const chunkLattice = this.world.chunkLattice;
    const groundY = 1;

    const placeLayer = (blocks: { x: number; y: number; z: number }[], blockId: number) => {
      for (const pos of blocks) {
        chunkLattice.setBlock({ x: pos.x, y: pos.y, z: pos.z }, blockId);
        this.towerBlockPositions.push({ ...pos });
      }
    };

    let prevY: number;
    let landingY: number;
    let prevRadius: number;
    let radius: number;
    let tierMaterial: number;

    if (tier === 1) {
      prevY = groundY;
      landingY = spec.landingY1;
      prevRadius = 1;
      radius = spec.radius1;
      tierMaterial = spec.materialTier1;
    } else if (tier === 2) {
      prevY = spec.landingY1;
      landingY = spec.landingY2;
      prevRadius = spec.radius1;
      radius = spec.radius2;
      tierMaterial = spec.materialTier2;
    } else {
      prevY = spec.landingY2;
      landingY = spec.landingY3;
      prevRadius = spec.radius2;
      radius = spec.radius3;
      tierMaterial = spec.materialTier3;
    }

    const cx = TOWER_CENTER_X;
    const cz = TOWER_CENTER_Z;
    const landing = [...landingBlocks(cx, cz, landingY, radius)];
    const stairsPos = [...stairBlocks(cx, cz, prevY, landingY, prevRadius, radius, spec.stairAxis, 1)];
    const stairsNeg = [...stairBlocks(cx, cz, prevY, landingY, prevRadius, radius, spec.stairAxis, -1)];
    let roofStairsPos: { x: number; y: number; z: number }[] = [];
    let roofStairsNeg: { x: number; y: number; z: number }[] = [];
    if (tier === 3) {
      const roofPrevR = Math.max(1, spec.radius3 - 1);
      roofStairsPos = [...stairBlocks(cx, cz, spec.landingY3, spec.roofY, roofPrevR, spec.radius3, spec.stairAxis, 1)];
      roofStairsNeg = [...stairBlocks(cx, cz, spec.landingY3, spec.roofY, roofPrevR, spec.radius3, spec.stairAxis, -1)];
    }
    const stairKeys = new Set([...stairsPos, ...stairsNeg, ...roofStairsPos, ...roofStairsNeg].map(b => `${b.x},${b.y},${b.z}`));

    const roofBlocks: { x: number; y: number; z: number }[] = [];
    if (tier === 3) {
      roofBlocks.push(...landingBlocks(cx, cz, spec.roofY, spec.radius3));
    }

    const allBlocks = [...landing, ...stairsPos, ...stairsNeg, ...roofStairsPos, ...roofStairsNeg, ...roofBlocks];
    const byY = new Map<number, { x: number; y: number; z: number }[]>();
    for (const b of allBlocks) {
      const list = byY.get(b.y) ?? [];
      list.push(b);
      byY.set(b.y, list);
    }

    const roofY = spec.roofY;
    for (const y of [...byY.keys()].sort((a, b) => a - b)) {
      const layer = byY.get(y)!;
      const splitLanding: { x: number; y: number; z: number }[] = [];
      const splitStairs: { x: number; y: number; z: number }[] = [];
      for (const b of layer) {
        if (stairKeys.has(`${b.x},${b.y},${b.z}`)) splitStairs.push(b);
        else splitLanding.push(b);
      }
      if (splitStairs.length) {
        placeLayer(splitStairs, spec.materialStairs);
      }
      if (splitLanding.length) {
        const isRoofLayer = y === roofY;
        const blockId = isRoofLayer ? spec.materialTier3 : tierMaterial;
        placeLayer(splitLanding, blockId);
      }
    }
  }

  getRoofZoneCenter(): { x: number; y: number; z: number } {
    const spec = this.spec;
    const y = spec ? spec.roofY : 11;
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
