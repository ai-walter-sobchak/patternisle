/**
 * Objective zone check using mapSpec.objective (deterministic).
 * Spec uses 2D plane: center.x = world X, center.y = world Z.
 */

import type { MapSpecV1 } from '../procgen/spec.js';

export function isInsideObjective(
  mapSpec: MapSpecV1 | null,
  playerPos: { x: number; y: number; z: number }
): boolean {
  if (!mapSpec) return false;
  const obj = mapSpec.objective;
  const dx = playerPos.x - obj.center.x;
  const dz = playerPos.z - obj.center.y;
  const distSq = dx * dx + dz * dz;
  return distSq <= obj.radius * obj.radius;
}
