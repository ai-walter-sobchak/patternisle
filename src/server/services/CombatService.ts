/**
 * Server-authoritative combat (v1): health, melee hit detection, cooldowns,
 * knockback, death/respawn, score attribution. All values from config/combat.
 *
 * Manual acceptance steps (v1):
 * - Attack within range: reduce victim HP by MELEE_DAMAGE (20); HUD updates.
 * - Attack outside range: tryMeleeAttack returns ok:true, hitPlayerId undefined; no damage.
 * - Cooldown: rapid attacks return ok:false reason:'cooldown' after first.
 * - Spawn protection: damage() returns prevented:true until invulnerableUntilMs; HUD shows shield.
 * - Death: health <= 0 → score +1 to attacker, respawn after RESPAWN_DELAY_MS, invuln SPAWN_PROTECTION_MS.
 * - HUD: health bar and number reflect current/max; shield icon while invulnerable.
 */

import type { World, Player } from 'hytopia';
import { PlayerManager } from 'hytopia';
import type { WorldState } from '../state/WorldState.js';
import type { RoundController } from '../systems/RoundController.js';
import type { HudService } from './HudService.js';
import type { ScoreService } from './ScoreService.js';
import {
  DEFAULT_MAX_HEALTH,
  MELEE_DAMAGE,
  MELEE_RANGE,
  ATTACK_COOLDOWN_MS,
  RESPAWN_DELAY_MS,
  SPAWN_PROTECTION_MS,
  KNOCKBACK_STRENGTH,
  KNOCKBACK_Y,
  FRIENDLY_FIRE,
  COMBAT_DEBUG,
} from '../config/combat.js';

export type DamageSourceKind = 'melee' | 'hazard' | 'unknown';

export interface DamageSource {
  kind: DamageSourceKind;
  attackerId?: string;
}

export interface DamageResult {
  killed: boolean;
  prevented?: boolean;
}

export interface TryMeleeAttackResult {
  ok: boolean;
  reason?: string;
  hitPlayerId?: string;
}

export class CombatService {
  constructor(
    private readonly world: World,
    private readonly worldState: WorldState,
    private readonly roundController: RoundController,
    private readonly hudService: HudService,
    private readonly scoreService: ScoreService
  ) {}

  resetHealth(playerId: string): void {
    const p = this.worldState.getPlayer(playerId);
    if (!p) return;
    const max = p.maxHealth ?? DEFAULT_MAX_HEALTH;
    p.health = max;
    if (COMBAT_DEBUG) {
      console.log(`[combat] resetHealth ${playerId} -> ${max}`);
    }
  }

  setMaxHealth(playerId: string, maxHealth: number): void {
    this.worldState.setMaxHealth(playerId, maxHealth);
  }

  getHealth(playerId: string): { health: number; maxHealth: number } {
    const result = this.worldState.getHealth(playerId);
    const max = result?.maxHealth ?? DEFAULT_MAX_HEALTH;
    const health = result?.health ?? max;
    return { health, maxHealth: max };
  }

  canAttack(attackerId: string, nowMs?: number): boolean {
    const now = nowMs ?? Date.now();
    if (this.worldState.roundState.status !== 'RUNNING') return false;
    const p = this.worldState.getPlayer(attackerId);
    if (!p) return false;
    const last = p.lastAttackAtMs ?? 0;
    return now >= last + ATTACK_COOLDOWN_MS;
  }

  /**
   * Melee attack: forward raycast (with small forgiveness). Returns hit player id if any.
   * Only valid when round is RUNNING; cooldown enforced.
   */
  tryMeleeAttack(attacker: Player, nowMs?: number): TryMeleeAttackResult {
    const now = nowMs ?? Date.now();
    const attackerId = attacker.id;

    if (this.worldState.roundState.status !== 'RUNNING') {
      return { ok: false, reason: 'round_not_running' };
    }

    if (!this.canAttack(attackerId, now)) {
      if (COMBAT_DEBUG) {
        console.log(`[combat] tryMeleeAttack ${attackerId} cooldown`);
      }
      return { ok: false, reason: 'cooldown' };
    }

    const hitPlayerId = this.performMeleeHitDetection(attacker);
    if (!hitPlayerId) {
      if (COMBAT_DEBUG) {
        console.log(`[combat] tryMeleeAttack ${attackerId} miss`);
      }
      const p = this.worldState.getPlayer(attackerId);
      if (p) p.lastAttackAtMs = now;
      return { ok: true, reason: undefined, hitPlayerId: undefined };
    }

    const p = this.worldState.getPlayer(attackerId);
    if (p) p.lastAttackAtMs = now;

    const result = this.damage(hitPlayerId, MELEE_DAMAGE, {
      kind: 'melee',
      attackerId,
    });

    if (result.killed && COMBAT_DEBUG) {
      console.log(`[combat] tryMeleeAttack ${attackerId} killed ${hitPlayerId}`);
    }

    this.applyKnockback(hitPlayerId, attackerId);

    return { ok: true, hitPlayerId };
  }

  /**
   * Apply damage. Only when round is RUNNING; spawn protection can prevent.
   * Returns { killed, prevented? }.
   */
  damage(
    victimId: string,
    amount: number,
    source: DamageSource
  ): DamageResult {
    if (this.worldState.roundState.status !== 'RUNNING') {
      return { killed: false, prevented: true };
    }

    const victimState = this.worldState.getPlayer(victimId);
    if (!victimState) return { killed: false, prevented: true };

    const now = Date.now();
    if (
      victimState.invulnerableUntilMs != null &&
      now < victimState.invulnerableUntilMs
    ) {
      if (COMBAT_DEBUG) {
        console.log(`[combat] damage ${victimId} prevented (spawn protection)`);
      }
      return { killed: false, prevented: true };
    }

    const attackerId = source.attackerId;
    if (attackerId && attackerId === victimId) return { killed: false, prevented: true };
    if (attackerId && !FRIENDLY_FIRE) {
      // Future: team check would go here; for v1 we allow all.
    }

    const maxHealth = victimState.maxHealth ?? DEFAULT_MAX_HEALTH;
    const current = victimState.health ?? maxHealth;
    victimState.health = Math.max(0, current - amount);
    victimState.lastDamagedAtMs = now;
    victimState.lastDamagedByPlayerId = attackerId;

    const killed = victimState.health <= 0;
    if (killed) {
      victimState.lastKillerId = attackerId ?? null;
      this.handleKO(victimId, attackerId);
    } else {
      const victimPlayer = this.getPlayerById(victimId);
      if (victimPlayer) this.hudService.sendHud(victimPlayer);
    }

    return { killed, prevented: false };
  }

  respawn(player: Player): void {
    this.roundController.respawnPlayer(player);
    this.resetHealth(player.id);
    const ps = this.worldState.getPlayer(player.id);
    if (ps) {
      ps.invulnerableUntilMs = Date.now() + SPAWN_PROTECTION_MS;
      ps.lastKillerId = undefined;
    }
    this.hudService.sendHud(player);
    if (COMBAT_DEBUG) {
      console.log(`[combat] respawn ${player.id}`);
    }
  }

  private performMeleeHitDetection(attacker: Player): string | undefined {
    const entities = this.world.entityManager.getPlayerEntitiesByPlayer(attacker);
    const attackerEntity = entities[0];
    if (!attackerEntity?.isSpawned) return undefined;

    const origin = attackerEntity.position;
    let direction = { x: 0, y: 0, z: -1 };
    if (attacker.camera?.facingDirection) {
      const fd = attacker.camera.facingDirection;
      direction = { x: fd.x, y: fd.y, z: fd.z };
    }
    const len = Math.sqrt(
      direction.x * direction.x +
        direction.y * direction.y +
        direction.z * direction.z
    );
    if (len < 0.001) direction = { x: 0, y: 0, z: -1 };
    else {
      direction = {
        x: direction.x / len,
        y: direction.y / len,
        z: direction.z / len,
      };
    }

    const connected = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    let best: { playerId: string; dist: number } | null = null;

    for (const other of connected) {
      if (other.id === attacker.id) continue;
      const otherEntities = this.world.entityManager.getPlayerEntitiesByPlayer(other);
      const otherEntity = otherEntities[0];
      if (!otherEntity?.isSpawned) continue;

      const targetPos = otherEntity.position;
      const dx = targetPos.x - origin.x;
      const dy = targetPos.y - origin.y;
      const dz = targetPos.z - origin.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > MELEE_RANGE) continue;

      const dot =
        (dx * direction.x + dy * direction.y + dz * direction.z) / Math.max(dist, 0.001);
      if (dot < 0.3) continue;

      if (!best || dist < best.dist) {
        best = { playerId: other.id, dist };
      }
    }

    return best?.playerId;
  }

  /** Apply knockback impulse to victim (e.g. after melee or /hit). */
  applyKnockback(victimId: string, attackerId: string): void {
    const victimPlayer = this.getPlayerById(victimId);
    const attackerPlayer = this.getPlayerById(attackerId);
    if (!victimPlayer || !attackerPlayer) return;

    const victimEntities = this.world.entityManager.getPlayerEntitiesByPlayer(victimPlayer);
    const attackerEntities = this.world.entityManager.getPlayerEntitiesByPlayer(attackerPlayer);
    const victimEntity = victimEntities[0];
    const attackerEntity = attackerEntities[0];
    if (!victimEntity?.isSpawned || !attackerEntity?.isSpawned) return;

    const ax = attackerEntity.position.x;
    const az = attackerEntity.position.z;
    const vx = victimEntity.position.x;
    const vz = victimEntity.position.z;
    let dx = vx - ax;
    let dz = vz - az;
    const xzLen = Math.sqrt(dx * dx + dz * dz) || 1;
    dx /= xzLen;
    dz /= xzLen;

    const impulse = {
      x: dx * KNOCKBACK_STRENGTH,
      y: KNOCKBACK_Y,
      z: dz * KNOCKBACK_STRENGTH,
    };

    if (typeof victimEntity.applyImpulse === 'function') {
      victimEntity.applyImpulse(impulse);
    }
  }

  private handleKO(victimId: string, attackerId: string | undefined): void {
    if (this.worldState.matchConfig.mode === 'survival') {
      (this.roundController as { onSurvivalPlayerDeath?: () => void }).onSurvivalPlayerDeath?.();
      return;
    }

    const attackerName = attackerId ? this.getPlayerDisplayName(attackerId) : null;
    const victimName = this.getPlayerDisplayName(victimId);
    const isEnvironment = !attackerId || attackerId === 'boundary' || attackerId === 'hazard';

    if (attackerId && !isEnvironment && attackerId !== victimId) {
      this.scoreService.addPoint(attackerId, attackerName ?? attackerId, 1, 'kill');
    }

    const toastMsg = isEnvironment
      ? `${victimName} took hazard damage`
      : `${attackerName} eliminated ${victimName} +1`;
    const feedMsg = isEnvironment
      ? `${victimName} fell to the hazard`
      : `${attackerName} eliminated ${victimName}`;
    this.hudService.broadcastToast('info', toastMsg);
    this.hudService.broadcastFeed(feedMsg);
    this.hudService.broadcastHud();

    const victimState = this.worldState.getPlayer(victimId);
    if (victimState) {
      victimState.controlsLockedUntilMs = Date.now() + RESPAWN_DELAY_MS;
    }

    setTimeout(() => {
      const victimPlayer = this.getPlayerById(victimId);
      if (!victimPlayer) return;
      this.respawn(victimPlayer);
      this.hudService.toast(victimPlayer, 'info', 'Respawned');
    }, RESPAWN_DELAY_MS);
  }

  private getPlayerDisplayName(playerId: string): string {
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    const found = players.find((p) => p.id === playerId);
    if (
      found &&
      'name' in found &&
      typeof (found as { name?: string }).name === 'string'
    ) {
      return (found as { name: string }).name;
    }
    return playerId;
  }

  private getPlayerById(playerId: string): Player | undefined {
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    return players.find((p) => p.id === playerId);
  }
}
