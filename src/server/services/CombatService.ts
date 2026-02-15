/**
 * Server-authoritative combat: damage, KO, respawn. Awards score on kill;
 * broadcasts HUD only on KO and round transitions (no per-tick spam).
 */

import type { World, Player } from 'hytopia';
import { PlayerManager } from 'hytopia';
import type { WorldState } from '../state/WorldState.js';
import type { RoundController } from '../systems/RoundController.js';
import type { HudService } from './HudService.js';
import type { ScoreService } from './ScoreService.js';

const KO_LOCKOUT_MS = 1500;

export class CombatService {
  constructor(
    private readonly world: World,
    private readonly worldState: WorldState,
    private readonly roundController: RoundController,
    private readonly hudService: HudService,
    private readonly scoreService: ScoreService
  ) {}

  /**
   * Apply damage to a player. Sets lastDamaged*; clamps health to 0.
   * On KO: award point to attacker, broadcast toast/feed/HUD, lock victim 1500ms, then respawn.
   * No damage when round is not RUNNING or victim is spawn-protected.
   */
  damage(
    victimId: string,
    attackerId: string,
    amount: number,
    _reason: string
  ): void {
    if (this.worldState.roundState.status !== 'RUNNING') {
      const attackerPlayer = this.getPlayerById(attackerId);
      if (attackerPlayer) {
        this.world.chatManager.sendPlayerMessage(
          attackerPlayer,
          'Round resetting...'
        );
      }
      return;
    }

    const victimState = this.worldState.getPlayer(victimId);
    if (!victimState) return;

    const now = Date.now();
    if (
      victimState.invulnerableUntilMs != null &&
      now < victimState.invulnerableUntilMs
    ) {
      const attackerPlayer = this.getPlayerById(attackerId);
      if (attackerPlayer) {
        this.world.chatManager.sendPlayerMessage(
          attackerPlayer,
          'Target is spawn-protected'
        );
      }
      return;
    }

    const currentHealth = victimState.health ?? 100;
    victimState.health = Math.max(0, currentHealth - amount);
    victimState.lastDamagedAtMs = now;
    victimState.lastDamagedByPlayerId = attackerId;

    if (victimState.health <= 0) {
      this.handleKO(victimId, attackerId);
    } else {
      const victimPlayer = this.getPlayerById(victimId);
      if (victimPlayer) this.hudService.sendHud(victimPlayer);
    }
  }

  private handleKO(victimId: string, attackerId: string): void {
    if (this.worldState.matchConfig.mode === 'survival') {
      (this.roundController as { onSurvivalPlayerDeath?: () => void }).onSurvivalPlayerDeath?.();
      return;
    }

    const attackerName = this.getPlayerDisplayName(attackerId);
    const victimName = this.getPlayerDisplayName(victimId);
    const isEnvironment = attackerId === 'boundary' || attackerId === 'hazard';

    if (!isEnvironment) {
      this.scoreService.addPoint(attackerId, attackerName, 1, 'kill');
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
      const now = Date.now();
      victimState.controlsLockedUntilMs = now + KO_LOCKOUT_MS;
    }

    setTimeout(() => {
      const victimPlayer = this.getPlayerById(victimId);
      if (!victimPlayer) return;
      this.respawn(victimPlayer);
      this.hudService.toast(victimPlayer, 'info', 'Respawned');
      this.hudService.sendHud(victimPlayer);
    }, KO_LOCKOUT_MS);
  }

  isAlive(playerId: string): boolean {
    const p = this.worldState.getPlayer(playerId);
    return (p?.health ?? 100) > 0;
  }

  resetHealth(playerId: string): void {
    const p = this.worldState.getPlayer(playerId);
    if (p) p.health = 100;
  }

  /** Teleport to respawn point, set health to 100, and grant 1.5s spawn protection. */
  respawn(player: Player): void {
    this.roundController.respawnPlayer(player);
    this.resetHealth(player.id);
    const ps = this.worldState.getPlayer(player.id);
    if (ps) ps.invulnerableUntilMs = Date.now() + 1500;
  }

  private getPlayerDisplayName(playerId: string): string {
    const players = PlayerManager.instance.getConnectedPlayersByWorld(
      this.world
    );
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
    const players = PlayerManager.instance.getConnectedPlayersByWorld(
      this.world
    );
    return players.find((p) => p.id === playerId);
  }
}
