/**
 * Shard pickup: state shape and in-world entity creation.
 * Server-authoritative; one spawn per match, deterministic from seed.
 */

import { Entity, World } from 'hytopia';
import type { Vector3Like } from 'hytopia';
import { ColliderShape, RigidBodyType } from 'hytopia';

export interface ShardPickupState {
  id: string;
  pos: { x: number; y: number; z: number };
  value: number;
  collected: boolean;
  /** Set when spawned; used to despawn from world. */
  entity: Entity | undefined;
}

const PICKUP_BLOCK_TEXTURE = 'blocks/coal-ore.png';
const PICKUP_HALF_EXTENTS = { x: 0.35, y: 0.35, z: 0.35 };

/**
 * Creates and spawns a single shard pickup entity in the world.
 * Caller owns the entity and must despawn it when collected.
 */
export function createShardPickupEntity(
  world: World,
  position: Vector3Like
): Entity {
  const entity = new Entity({
    name: 'ShardPickup',
    isEnvironmental: true,
    blockTextureUri: PICKUP_BLOCK_TEXTURE,
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
