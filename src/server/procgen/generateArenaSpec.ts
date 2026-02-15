import { Rng } from "../../shared/rng/Rng";
import { Cover, MapSpecV1, Rect, SpawnZone, Vec2, WallSegment } from "./spec";

type Opts = {
  size?: number;     // default 250
  rings?: 3;          // locked to 3
  teams?: 4;          // locked to 4
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

  // Outer radius leaves boundary margin; allow small jitter
  const outerRadius = clamp(Math.floor(size * 0.46) + rng.int(-4, 6), 100, Math.floor(size / 2) - 6);

  // 3 rings: outer boundary, mid ring, inner ring (around objective approaches)
  const ringGapBase = rng.int(18, 26);
  const ringGapJitter = () => rng.int(-3, 3);

  const r0 = outerRadius;
  const r1 = clamp(r0 - (ringGapBase + ringGapJitter()), 40, r0 - 10);
  const r2 = clamp(r1 - (ringGapBase + ringGapJitter()), 26, r1 - 10);

  const segments = rng.int(16, 24);     // more segments = smoother rings
  const spokes = rng.int(5, 9);         // spoke lanes

  const wallThickness = rng.int(2, 3);  // blocks

  const wallSegments: WallSegment[] = [];

  // Gates per ring: ensure at least 4 spread per ring so each quadrant has a path (connectivity)
  const spreadGates = (count: number) => {
    const s = new Set<number>();
    // One gate per quadrant (0°, 90°, 180°, 270°) plus jitter so all 4 spawns can reach center
    const step = Math.max(1, Math.floor(segments / 4));
    for (let q = 0; q < 4; q++) {
      const base = (q * step + rng.int(0, Math.max(0, step - 1))) % segments;
      s.add(base);
    }
    while (s.size < count) s.add(rng.int(0, segments - 1));
    return s;
  };
  const gateCountOuter = rng.int(4, 6);
  const gateCountMid = rng.int(4, 6);
  const gateCountInner = rng.int(3, 5);

  const gatesOuter = spreadGates(gateCountOuter);
  const gatesMid = spreadGates(gateCountMid);
  const gatesInner = spreadGates(gateCountInner);

  // Optional perimeter dents (only add, never remove the spread gates)
  if (rng.bool(0.5)) {
    for (const g of Array.from(gatesOuter)) {
      if (rng.bool(0.4)) gatesOuter.add((g + 1) % segments);
      if (rng.bool(0.25)) gatesOuter.add((g + segments - 1) % segments);
    }
  }

  addRing(wallSegments, center, r0, segments, wallThickness, gatesOuter, "perimeter");
  addRing(wallSegments, center, r1, segments, wallThickness, gatesMid, "ring");
  addRing(wallSegments, center, r2, segments, wallThickness, gatesInner, "ring");

  // Spokes: choose angles not evenly spaced, and allow "missing spoke" segments to create asymmetry
  const spokeAngles: number[] = [];
  const baseAngles = rng.shuffle([0, 60, 120, 180, 240, 300, 30, 90, 150, 210, 270, 330]);
  for (let i = 0; i < spokes; i++) {
    const a = baseAngles[i % baseAngles.length] + rng.int(-10, 10);
    spokeAngles.push((a + 360) % 360);
  }

  for (const a of spokeAngles) {
    // Each spoke goes from near outer ring to near inner ring, but can have a gap (choke) or offset
    const startR = r0 - rng.int(6, 10);
    const endR = r2 + rng.int(4, 10);

    const p0 = polar(center, startR, a);
    const p1 = polar(center, endR, a);

    // Optional choke/gap in the middle (reduced so lanes stay connected)
    if (rng.bool(0.2)) {
      const midR = (startR + endR) / 2;
      const gap = rng.int(10, 18);
      const pA = polar(center, midR + gap / 2, a);
      const pB = polar(center, midR - gap / 2, a);
      wallSegments.push({ a: p0, b: pA, thickness: wallThickness, tag: "spoke" });
      wallSegments.push({ a: pB, b: p1, thickness: wallThickness, tag: "spoke" });
    } else {
      wallSegments.push({ a: p0, b: p1, thickness: wallThickness, tag: "spoke" });
    }
  }

  // Objective
  const objectiveRadius = rng.int(10, 14); // blocks
  const objective = { center, radius: objectiveRadius };

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

  // Cover: seeded scatter in mid lanes, avoid spawn pads and objective donut
  const cover: Cover[] = [];
  const coverCount = rng.int(60, 95);

  const isInsideObjectiveNoCover = (p: Vec2) => dist(p, center) < objectiveRadius + 12; // donut
  const isInsideSpawn = (p: Vec2) => spawnZones.some((s) => {
    const r = s.rect;
    return p.x >= r.x - 2 && p.x <= r.x + r.w + 2 && p.y >= r.y - 2 && p.y <= r.y + r.h + 2;
  });

  for (let i = 0; i < coverCount; i++) {
    // sample radius mostly between mid and inner ring
    const rr = rng.int(r2 + 8, r0 - 12);
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
    rings: 3,
    ringRadii: [r0, r1, r2],
    segments,
    spokes,
    spawnZones,
    objective,
    wallSegments,
    cover,
  };
}
