/**
 * Combat v1 tuning. All combat values come from here (no magic numbers).
 */

export const DEFAULT_MAX_HEALTH = 100;
export const MELEE_DAMAGE = 20;
export const MELEE_RANGE = 3.0;
export const ATTACK_COOLDOWN_MS = 450;
export const RESPAWN_DELAY_MS = 1200;
export const SPAWN_PROTECTION_MS = 1500;
export const KNOCKBACK_STRENGTH = 8;
export const KNOCKBACK_Y = 3;
export const FRIENDLY_FIRE = true;

/** When true, log combat actions (cooldown, hit, damage, KO). Avoid per-tick spam. */
export const COMBAT_DEBUG = false;
