import { MapSpecV1, Vec2, WallSegment } from "./spec";

/** Margin in blocks beyond outer ring for bake bounds. Reduces grid size when map is larger than arena. */
const ARENA_BAKE_MARGIN = 15;

export type BakedGrid = {
  size: number;       // number of cells per side (cropped square)
  cellSize: number;   // blocks per cell
  blocked: Uint8Array; // 0 walkable, 1 blocked
  /** Cell-space origin: grid (0,0) = world (originX, originY). Omitted when not cropped. */
  originX?: number;
  originY?: number;
};

function idx(x: number, y: number, n: number) {
  return y * n + x;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function setBlockedLocal(g: BakedGrid, lx: number, ly: number) {
  if (lx < 0 || ly < 0 || lx >= g.size || ly >= g.size) return;
  g.blocked[idx(lx, ly, g.size)] = 1;
}

// Bresenham-ish line rasterization in world cell space; stamps into grid (local coords if cropped).
function rasterSegment(
  g: BakedGrid,
  seg: WallSegment,
  worldToLocal: (wx: number, wy: number) => { x: number; y: number } | null
) {
  const cs = g.cellSize;

  const x0 = Math.round(seg.a.x / cs);
  const y0 = Math.round(seg.a.y / cs);
  const x1 = Math.round(seg.b.x / cs);
  const y1 = Math.round(seg.b.y / cs);

  let dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;

  let x = x0, y = y0;

  const t = Math.max(1, Math.round(seg.thickness / cs));
  const stamp = (wx: number, wy: number) => {
    const loc = worldToLocal(wx, wy);
    if (!loc) return;
    for (let oy = -t; oy <= t; oy++) {
      for (let ox = -t; ox <= t; ox++) {
        setBlockedLocal(g, loc.x + ox, loc.y + oy);
      }
    }
  };

  while (true) {
    stamp(x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

/**
 * Rasterize spec walls onto a boolean grid for BFS.
 * Connectivity validation must use cellSize=1 to avoid aliasing (thin gates can alias shut at coarser resolution).
 */
export function bakeGridFromSpec(spec: MapSpecV1, cellSize = 1): BakedGrid {
  const cs = cellSize;
  const center = spec.center;
  const outer = spec.ringRadii[0];
  const nFull = Math.ceil(spec.size / cs);

  // Crop to bounding square around arena (outer ring + margin) for perf when map is larger than arena
  const arenaRadius = outer + ARENA_BAKE_MARGIN;
  const minBx = Math.max(0, center.x - arenaRadius);
  const maxBx = Math.min(spec.size, center.x + arenaRadius);
  const minBy = Math.max(0, center.y - arenaRadius);
  const maxBy = Math.min(spec.size, center.y + arenaRadius);
  const minCx = Math.max(0, Math.floor(minBx / cs));
  const maxCx = Math.min(nFull - 1, Math.floor(maxBx / cs));
  const minCy = Math.max(0, Math.floor(minBy / cs));
  const maxCy = Math.min(nFull - 1, Math.floor(maxBy / cs));

  const useCrop = maxCx - minCx + 1 < nFull || maxCy - minCy + 1 < nFull;
  const size = useCrop ? Math.max(maxCx - minCx + 1, maxCy - minCy + 1) : nFull;
  const blocked = new Uint8Array(size * size);

  const g: BakedGrid = {
    size,
    cellSize: cs,
    blocked,
    ...(useCrop ? { originX: minCx, originY: minCy } : {}),
  };

  const centerCx = center.x / cs;
  const centerCy = center.y / cs;
  const outerCells = outer / cs + 2;

  const worldToLocal = (wx: number, wy: number): { x: number; y: number } | null => {
    if (useCrop) {
      const lx = wx - minCx;
      const ly = wy - minCy;
      if (lx < 0 || ly < 0 || lx >= size || ly >= size) return null;
      return { x: lx, y: ly };
    }
    if (wx < 0 || wy < 0 || wx >= size || wy >= size) return null;
    return { x: wx, y: wy };
  };

  for (let ly = 0; ly < size; ly++) {
    for (let lx = 0; lx < size; lx++) {
      const wx = useCrop ? minCx + lx : lx;
      const wy = useCrop ? minCy + ly : ly;
      const dx = wx - centerCx;
      const dy = wy - centerCy;
      if (Math.sqrt(dx * dx + dy * dy) > outerCells) blocked[idx(lx, ly, size)] = 1;
    }
  }

  for (const seg of spec.wallSegments) rasterSegment(g, seg, worldToLocal);

  return g;
}

export function toCell(g: BakedGrid, p: Vec2): { x: number; y: number } {
  const wx = Math.floor(p.x / g.cellSize);
  const wy = Math.floor(p.y / g.cellSize);
  if (g.originX !== undefined && g.originY !== undefined) {
    const lx = wx - g.originX;
    const ly = wy - g.originY;
    return {
      x: clamp(lx, 0, g.size - 1),
      y: clamp(ly, 0, g.size - 1),
    };
  }
  return {
    x: clamp(wx, 0, g.size - 1),
    y: clamp(wy, 0, g.size - 1),
  };
}
