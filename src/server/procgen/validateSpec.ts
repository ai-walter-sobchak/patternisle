import { MapSpecV1 } from "./spec";

export function validateSpec(spec: MapSpecV1): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (spec.v !== 1) errors.push("spec.v must be 1");
  if (spec.size <= 0) errors.push("spec.size must be > 0");
  if (spec.rings !== 3) errors.push("spec.rings must be 3");
  if (!spec.ringRadii || spec.ringRadii.length !== 3) errors.push("spec.ringRadii must have 3 entries");

  const [r0, r1, r2] = spec.ringRadii;
  if (!(r0 > r1 && r1 > r2 && r2 > 0)) errors.push("ringRadii must be strictly decreasing and > 0");

  if (spec.spawnZones.length !== 4) errors.push("must have exactly 4 spawnZones");
  const teams = new Set(spec.spawnZones.map(s => s.teamId));
  if (teams.size !== 4) errors.push("spawnZones must include teamId 0..3 exactly once");

  // bounds checks
  const inBoundsRect = (x: number, y: number, w: number, h: number) =>
    x >= 0 && y >= 0 && x + w <= spec.size && y + h <= spec.size;

  for (const s of spec.spawnZones) {
    const { x, y, w, h } = s.rect;
    if (!inBoundsRect(x, y, w, h)) errors.push(`spawn rect out of bounds for team ${s.teamId}`);
    if (w <= 0 || h <= 0) errors.push(`spawn rect invalid size for team ${s.teamId}`);
  }

  if (spec.objective.radius <= 0) errors.push("objective.radius must be > 0");
  if (spec.objective.center.x !== spec.center.x || spec.objective.center.y !== spec.center.y) {
    errors.push("objective must be centered at spec.center");
  }

  if (spec.wallSegments.length === 0) errors.push("wallSegments must not be empty");

  return errors.length ? { ok: false, errors } : { ok: true };
}
