/**
 * Sample spawn positions spread across the arena rings (procgen spec).
 * World coords: spec center = (0,0), so radius in spec = radius in world.
 */

import type { MapSpecV1 } from './spec.js';

/** Margin from ring walls so pickups don't spawn inside walls. */
const RING_MARGIN = 6;

/**
 * Returns world-space { x, z } for one pickup, sampling in the three ring bands
 * so items are spread across outer, mid, and inner lanes. Uses rng() for determinism.
 */
export function sampleRingPosition(
  spec: MapSpecV1,
  rng: () => number
): { x: number; z: number } {
  const radii = spec.ringRadii;
  const r0 = radii[0];
  const innerR = radii[radii.length - 1];
  const objR = spec.objective.radius;

  // Bands: outer (r1..r0), then each gap (r_i+1..r_i), then inner (objR..innerR). Pick band then random in band.
  const numBands = radii.length;
  const band = Math.floor(rng() * numBands);
  let minR: number;
  let maxR: number;
  if (band === 0) {
    minR = radii[1] + RING_MARGIN;
    maxR = r0 - RING_MARGIN;
  } else if (band === numBands - 1) {
    minR = objR + RING_MARGIN;
    maxR = Math.max(minR + 2, innerR - RING_MARGIN);
  } else {
    minR = radii[band + 1] + RING_MARGIN;
    maxR = radii[band] - RING_MARGIN;
  }

  const radius = minR + rng() * (maxR - minR);
  const angle = rng() * 2 * Math.PI;
  return {
    x: radius * Math.cos(angle),
    z: radius * Math.sin(angle),
  };
}
