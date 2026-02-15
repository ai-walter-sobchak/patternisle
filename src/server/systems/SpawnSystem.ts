/**
 * Spawn system: inner ring around map center (plus center), fairness (max distance from nearest enemy),
 * safety (minDist from any player), and last-used index to reduce repetition.
 */

import type { WorldState } from '../state/WorldState.js';
import type { SpawnPoint } from '../state/types.js';
import type { MapSpecV1 } from '../procgen/spec.js';

const MIN_SAFE_DIST = 4.0;
const MIN_SAFE_DIST_SQ = MIN_SAFE_DIST * MIN_SAFE_DIST;

export interface ArenaBoundsLike {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y: number;
}

/** Other players' positions for spawn fairness/safety. */
export interface PlayerPosition {
  playerId: string;
  position: { x: number; y: number; z: number };
}

function sqDist(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export class SpawnSystem {
  constructor(private readonly worldState: WorldState) {}

  /**
   * Build spawn points from map blocks: top surface only, buffered from edges,
   * then select `count` points spread out (minDist in XZ). Guarantees no void spawns.
   */
  buildSurfaceSpawnPointsFromMap(
    map: { blocks?: Record<string, unknown> },
    count: number = 16,
    edgeBuffer: number = 2
  ): SpawnPoint[] {
    const blocks = map?.blocks;
    if (!blocks || typeof blocks !== 'object') {
      this.worldState.spawn.spawnPoints = [];
      return [];
    }

    // A) Top Y per (x,z)
    const topYByXZ = new Map<string, number>();
    for (const key of Object.keys(blocks)) {
      const parts = key.split(',').map(Number);
      if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) continue;
      const [x, y, z] = parts;
      const xzKey = `${x},${z}`;
      const current = topYByXZ.get(xzKey);
      if (current === undefined || y > current) topYByXZ.set(xzKey, y);
    }

    if (topYByXZ.size === 0) {
      this.worldState.spawn.spawnPoints = [];
      return [];
    }

    const has = (x: number, z: number) => topYByXZ.has(`${x},${z}`);
    const neighbors4 = (x: number, z: number) =>
      [
        [x + 1, z],
        [x - 1, z],
        [x, z + 1],
        [x, z - 1],
      ] as [number, number][];

    // B) Edge tiles (any 4-neighbor missing)
    const edgeTiles = new Set<string>();
    for (const xzKey of topYByXZ.keys()) {
      const [x, z] = xzKey.split(',').map(Number);
      for (const [nx, nz] of neighbors4(x, z)) {
        if (!has(nx, nz)) {
          edgeTiles.add(xzKey);
          break;
        }
      }
    }

    // C) Apply edge buffer: bad = tiles within edgeBuffer steps of an edge
    let bad = new Set(edgeTiles);
    for (let step = 0; step < edgeBuffer; step++) {
      const next = new Set(bad);
      for (const xzKey of bad) {
        const [x, z] = xzKey.split(',').map(Number);
        for (const [nx, nz] of neighbors4(x, z)) {
          const nKey = `${nx},${nz}`;
          if (topYByXZ.has(nKey)) next.add(nKey);
        }
      }
      bad = next;
    }

    // D) Candidates: (x, topY+6, z) for each safe (x,z) — raycast starts above geometry
    const candidates: SpawnPoint[] = [];
    for (const xzKey of topYByXZ.keys()) {
      if (bad.has(xzKey)) continue;
      const [x, z] = xzKey.split(',').map(Number);
      const y = (topYByXZ.get(xzKey) ?? 0) + 6;
      candidates.push({ x, y, z });
    }

    if (candidates.length === 0) {
      this.worldState.spawn.spawnPoints = [];
      return [];
    }

    // E) Shuffle (Fisher–Yates) then greedy pick by minDist
    const rng = () => Math.random();
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    const xzDist = (a: SpawnPoint, b: SpawnPoint) =>
      Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);

    const selectWithMinDist = (minDist: number): SpawnPoint[] => {
      const selected: SpawnPoint[] = [];
      for (const p of candidates) {
        if (selected.length >= count) break;
        const farEnough = selected.every(s => xzDist(p, s) >= minDist);
        if (farEnough) selected.push(p);
      }
      return selected;
    };

    let selected = selectWithMinDist(6);
    if (selected.length < count) selected = selectWithMinDist(4);
    if (selected.length < count) {
      selected = candidates.slice(0, count);
    }

    // F) Store
    this.worldState.spawn.spawnPoints = selected;
    return selected;
  }

  /**
   * Build spawn points from procgen spec spawn zones so players spawn inside the arena pads,
   * not on the outer edge of the map. Converts spec 2D coords to world 3D (centered at 0,0).
   */
  buildSpawnPointsFromProcgenSpec(spec: MapSpecV1, count: number = 16): SpawnPoint[] {
    const center = spec.center;
    const points: SpawnPoint[] = [];
    const spawnY = 6; // above floor; raycast will find ground

    for (const zone of spec.spawnZones) {
      const { x, y, w, h } = zone.rect;
      // World coords: spec (x,y) -> world x = x - center.x, z = y - center.y
      const toWorld = (sx: number, sy: number): SpawnPoint => ({
        x: sx - center.x,
        y: spawnY,
        z: sy - center.y,
      });
      // 4 points per zone: center + three spread within the rect
      points.push(toWorld(x + w / 2, y + h / 2));
      points.push(toWorld(x + w * 0.25, y + h * 0.25));
      points.push(toWorld(x + w * 0.75, y + h * 0.75));
      points.push(toWorld(x + w * 0.25, y + h * 0.75));
    }

    this.worldState.spawn.spawnPoints = points.slice(0, count);
    return this.worldState.spawn.spawnPoints;
  }

  /**
   * Build spawn points on an inner ring around map center (plus one at center).
   * Uses bounds { minX, maxX, minZ, maxZ, y }; count defaults to 16.
   */
  buildPerimeterSpawnPoints(
    bounds: ArenaBoundsLike,
    count: number = 16
  ): SpawnPoint[] {
    const { minX, maxX, minZ, maxZ, y } = bounds;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const r = 0.35 * Math.min(maxX - minX, maxZ - minZ);
    const points: SpawnPoint[] = [];

    for (let i = 0; i < count; i++) {
      const theta = (i / count) * 2 * Math.PI;
      points.push({
        x: cx + Math.cos(theta) * r,
        y,
        z: cz + Math.sin(theta) * r
      });
    }
    points[0] = { x: cx, y, z: cz };

    this.worldState.spawn.spawnPoints = points;
    return points;
  }

  /**
   * Get best spawn position for a player: safe (minDist from any player),
   * fair (max distance from nearest enemy), and avoid repeating last index.
   * players = list of other active players with positions (caller provides).
   */
  getSpawnForPlayer(playerId: string, players: PlayerPosition[]): SpawnPoint {
    const points = this.worldState.spawn.spawnPoints;
    const lastByPlayer = this.worldState.spawn.lastSpawnIndexByPlayerId;
    const lastIdx = lastByPlayer[playerId] ?? -1;

    const others = players.filter(p => p.playerId !== playerId);

    type Candidate = { index: number; point: SpawnPoint; nearestEnemyDist: number; safe: boolean };
    const candidates: Candidate[] = points.map((point, index) => {
      let nearestEnemyDistSq = Infinity;
      let minDistToAnyPlayerSq = Infinity;
      for (const o of others) {
        const dSq = sqDist(point, o.position);
        if (dSq < nearestEnemyDistSq) nearestEnemyDistSq = dSq;
        if (dSq < minDistToAnyPlayerSq) minDistToAnyPlayerSq = dSq;
      }
      if (others.length === 0) nearestEnemyDistSq = 0;
      const nearestEnemyDist = Math.sqrt(nearestEnemyDistSq);
      const safe = minDistToAnyPlayerSq >= MIN_SAFE_DIST_SQ;
      return { index, point, nearestEnemyDist, safe };
    });

    const safeCandidates = candidates.filter(c => c.safe);
    const pool = safeCandidates.length > 0 ? safeCandidates : candidates;

    const notLast = pool.filter(c => c.index !== lastIdx);
    const preferred = notLast.length > 0 ? notLast : pool;

    let best = preferred[0];
    for (let i = 1; i < preferred.length; i++) {
      const c = preferred[i];
      if (c.nearestEnemyDist > best.nearestEnemyDist) best = c;
    }

    this.worldState.spawn.lastSpawnIndexByPlayerId[playerId] = best.index;

    if (process.env.NODE_ENV !== 'production') {
      const safe = best.safe;
      const name = playerId.slice(0, 8);
      console.log(
        `[spawn] player=${name} idx=${best.index} nearestEnemy=${best.nearestEnemyDist.toFixed(2)} safe=${safe}`
      );
    }

    return { ...best.point };
  }
}
