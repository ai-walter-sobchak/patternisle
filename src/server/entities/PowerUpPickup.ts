/**
 * Power-up pickup: visible in-world entity for ambient power-ups.
 * Emerald = SPEED, Diamond = JUMP. Server-authoritative; spawn/despawn when PowerUpSystem collects.
 */

import { Entity, World } from 'hytopia';
import type { Vector3Like } from 'hytopia';
import { ColliderShape, RigidBodyType } from 'hytopia';
import type { PowerUpKind } from '../state/types.js';

const PICKUP_HALF_EXTENTS = { x: 0.4, y: 0.4, z: 0.4 };

/** Texture per power-up kind so players can tell them apart. */
const TEXTURE_BY_KIND: Record<PowerUpKind, string> = {
  SPEED: 'blocks/emerald-ore.png',
  JUMP: 'blocks/diamond-ore.png',
  SHIELD: 'blocks/emerald-ore.png',
  MAGNET: 'blocks/emerald-ore.png',
  DOUBLE_AMBIENT: 'blocks/emerald-ore.png',
  HEAL: 'blocks/emerald-ore.png',
};

/**
 * Creates and spawns a single power-up pickup entity in the world.
 * SPEED = emerald, JUMP = diamond. Caller owns the entity and must despawn it when collected.
 */
export function createPowerUpPickupEntity(
  world: World,
  position: Vector3Like,
  kind: PowerUpKind
): Entity {
  const blockTextureUri = TEXTURE_BY_KIND[kind] ?? TEXTURE_BY_KIND.SPEED;
  const entity = new Entity({
    name: 'PowerUpPickup',
    isEnvironmental: true,
    blockTextureUri,
    blockHalfExtents: PICKUP_HALF_EXTENTS,
    rigidBodyOptions: {
      type: RigidBodyType.FIXED,
      colliders: [
        {
          shape: ColliderShape.BLOCK,
          halfExtents: PICKUP_HALF_EXTENTS,
        },
      ],
    },
  });
  entity.spawn(world, position);
  return entity;
}
