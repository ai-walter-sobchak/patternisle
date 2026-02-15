import { Rng } from "../../shared/rng/Rng";
import { Cover, MapSpecV1, Rect, SpawnZone, Vec2, WallSegment } from "./spec";

type Opts = {
  size?: number;     // default 250
  rings?: 3 | 4 | 5; // 4–5 for tighter center maze
  teams?: 4;         // locked to 4
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function degToRad(d: number) {
  return (d * Math.PI) / 180;
}

function polar(center: Vec2, radius: number, deg: number): Vec2 {
  const a = degToRad(deg);
  return { x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius };
}

// Approximate circular arc with chords
function addRing(
  segs: WallSegment[],
  center: Vec2,
  radius: number,
  segments: number,
  thickness: number,
  gates: Set<number>,
  tag: WallSegment["tag"]
) {
  for (let i = 0; i < segments; i++) {
    if (gates.has(i)) continue; // skip this segment = gate/opening
    const a0 = (i * 360) / segments;
    const a1 = ((i + 1) * 360) / segments;
    const p0 = polar(center, radius, a0);
    const p1 = polar(center, radius, a1);
    segs.push({ a: p0, b: p1, thickness, tag });
  }
}

// Place a rectangular spawn pad near outer ring at an angle
function spawnRectAtAngle(size: number, center: Vec2, outerR: number, angleDeg: number, padW: number, padH: number): Rect {
  // point on outer ring, then pull inward a bit so rect fits
  const inward = Math.max(6, Math.floor(padH / 2));
  const p = polar(center, outerR - inward, angleDeg);

  const x = Math.round(p.x - padW / 2);
  const y = Math.round(p.y - padH / 2);

  return {
    x: clamp(x, 2, size - padW - 2),
    y: clamp(y, 2, size - padH - 2),
    w: padW,
    h: padH,
  };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function rectCenter(r: Rect): Vec2 {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function dist(a: Vec2, b: Vec2) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function generateArenaSpec(seed: string, opts: Opts = {}): MapSpecV1 {
  const size = opts.size ?? 250;
  const rng = new Rng(seed);

  const center: Vec2 = { x: Math.floor(size / 2), y: Math.floor(size / 2) };

  // Tighter outer radius so center and lanes feel less wide open
  const outerRadius = clamp(Math.floor(size * 0.40) + rng.int(-6, 8), 85, Math.floor(size / 2) - 6);

  // Ring count: 4 or 5 for more concentric corridors and a tighter center maze
  const numRings = (opts.rings ?? rng.pick([4, 5])) as 3 | 4 | 5;

  // Narrower ring gaps; inner gaps smaller so we don't run out of radius
  const ringGapBase = rng.int(10, 18);
  const ringGapJitter = () => rng.int(-2, 3);
  const innerGapScale = 0.7; // inner rings closer together

  const r0 = outerRadius;
  const ringRadii: number[] = [r0];
  let rPrev = r0;
  for (let i = 1; i < numRings; i++) {
    const gap = i >= numRings - 1 ? (ringGapBase + ringGapJitter()) * innerGapScale : ringGapBase + ringGapJitter();
    const rNext = clamp(rPrev - gap, i === numRings - 1 ? 16 : 20, rPrev - 6);
    ringRadii.push(rNext);
    rPrev = rNext;
  }
  const innerR = ringRadii[ringRadii.length - 1];

  // More segments and spokes = more maze corridors and winding paths
  const segments = rng.int(24, 36);
  const spokes = rng.int(6, 12);

  // 2–3 blocks: thick enough for corridors but gates stay open for connectivity
  const wallThickness = rng.int(2, 3);

  const wallSegments: WallSegment[] = [];

  // Fewer gates = more winding paths; keep one per quadrant for connectivity
  const spreadGates = (count: number) => {
    const s = new Set<number>();
    const step = Math.max(1, Math.floor(segments / 4));
    for (let q = 0; q < 4; q++) {
      const base = (q * step + rng.int(0, Math.max(0, step - 1))) % segments;
      s.add(base);
    }
    while (s.size < count) s.add(rng.int(0, segments - 1));
    return s;
  };

  // Gates per ring: outer has more, inner fewer so center is maze-like
  for (let i = 0; i < ringRadii.length; i++) {
    const gateCount = i === 0 ? rng.int(4, 6) : Math.max(3, rng.int(3, 5) - i);
    const gates = spreadGates(gateCount);
    const tag = i === 0 ? "perimeter" : "ring";
    addRing(wallSegments, center, ringRadii[i], segments, wallThickness, gates, tag);
  }

  // Spokes: varied angles and more often with mid gaps for winding routes
  const spokeAngles: number[] = [];
  const baseAngles = rng.shuffle([0, 60, 120, 180, 240, 300, 30, 90, 150, 210, 270, 330]);
  for (let i = 0; i < spokes; i++) {
    const a = baseAngles[i % baseAngles.length] + rng.int(-12, 12);
    spokeAngles.push((a + 360) % 360);
  }

  for (const a of spokeAngles) {
    const startR = r0 - rng.int(6, 12);
    const endR = innerR + rng.int(2, 8);

    const p0 = polar(center, startR, a);
    const p1 = polar(center, endR, a);

    // More often add a choke so you have to wind around
    if (rng.bool(0.5)) {
      const midR = (startR + endR) / 2;
      const gap = rng.int(6, 12);
      const pA = polar(center, midR + gap / 2, a);
      const pB = polar(center, midR - gap / 2, a);
      wallSegments.push({ a: p0, b: pA, thickness: wallThickness, tag: "spoke" });
      wallSegments.push({ a: pB, b: p1, thickness: wallThickness, tag: "spoke" });
    } else {
      wallSegments.push({ a: p0, b: p1, thickness: wallThickness, tag: "spoke" });
    }
  }

  // Objective: small center so the middle is a clear goal
  const objectiveRadius = rng.int(6, 10); // blocks
  const objective = { center, radius: objectiveRadius };

  // Inner maze: short radial walls inside the innermost ring (don't reach center) for extra winding
  const innerMazeSpokes = rng.int(3, 6);
  const innerMazeAngles = rng.shuffle([0, 45, 90, 135, 180, 225, 270, 315]).slice(0, innerMazeSpokes);
  for (const a of innerMazeAngles) {
    const aDeg = (a + rng.int(-12, 12) + 360) % 360;
    const startR = innerR - rng.int(2, 4);
    const endR = innerR - rng.int(6, 11);
    if (endR < objectiveRadius + 5) continue;
    const p0 = polar(center, startR, aDeg);
    const p1 = polar(center, endR, aDeg);
    wallSegments.push({ a: p0, b: p1, thickness: wallThickness, tag: "spoke" });
  }

  // Objective: smaller center so the middle isn’t so vast
  // Spawn zones: 4 outer pads at roughly quadrants, with per-team jitter and variable pad size
  const padW = rng.int(10, 14);
  const padH = rng.int(10, 14);

  const baseSpawnAngles = [0, 90, 180, 270];
  const spawnAngles = baseSpawnAngles.map((a) => (a + rng.int(-22, 22) + 360) % 360);

  const spawnZones: SpawnZone[] = [];
  for (let teamId = 0 as 0 | 1 | 2 | 3; teamId < 4; teamId = ((teamId + 1) as 0 | 1 | 2 | 3)) {
    let rect = spawnRectAtAngle(size, center, r0, spawnAngles[teamId], padW, padH);

    // ensure no overlap and keep distance
    let attempts = 0;
    while (attempts < 20) {
      const overlaps = spawnZones.some((s) => rectsOverlap(rect, s.rect));
      const farEnough = spawnZones.every((s) => dist(rectCenter(rect), rectCenter(s.rect)) > 30);
      if (!overlaps && farEnough) break;

      // jitter angle and retry
      const jittered = (spawnAngles[teamId] + rng.int(-18, 18) + 360) % 360;
      rect = spawnRectAtAngle(size, center, r0, jittered, padW, padH);
      attempts++;
    }

    spawnZones.push({
      teamId,
      rect,
      facingDeg: (spawnAngles[teamId] + 180) % 360, // face inward
    });
  }

  // Cover + accents: more obstacles along the way so areas feel less wide open
  const cover: Cover[] = [];
  const coverCount = rng.int(100, 145);

  const isInsideObjectiveNoCover = (p: Vec2) => dist(p, center) < objectiveRadius + 10; // donut
  const isInsideSpawn = (p: Vec2) => spawnZones.some((s) => {
    const r = s.rect;
    return p.x >= r.x - 2 && p.x <= r.x + r.w + 2 && p.y >= r.y - 2 && p.y <= r.y + r.h + 2;
  });

  for (let i = 0; i < coverCount; i++) {
    // sample radius between inner and outer ring so obstacles fill lanes and center approach
    const rr = rng.int(innerR + 6, r0 - 10);
    const aa = rng.int(0, 359);
    const p = polar(center, rr, aa);

    const pp: Vec2 = { x: clamp(Math.round(p.x), 2, size - 3), y: clamp(Math.round(p.y), 2, size - 3) };
    if (isInsideObjectiveNoCover(pp)) continue;
    if (isInsideSpawn(pp)) continue;

    cover.push({
      center: pp,
      radius: rng.int(1, 2),
      kind: rng.pick(["pillar", "crate", "lowwall"]),
    });
  }

  return {
    v: 1,
    seed,
    size,
    center,
    rings: numRings,
    ringRadii,
    segments,
    spokes,
    spawnZones,
    objective,
    wallSegments,
    cover,
  };
}
