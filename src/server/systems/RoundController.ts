/**
 * Round loop: start → collect shards → first to TARGET_SHARDS wins → delay → reset → start.
 * Server-authoritative; safe with join/leave mid-round.
 */

import type { World, Player } from 'hytopia';
import { PlayerManager } from 'hytopia';
import type { WorldState } from '../state/WorldState.js';
import type { ShardSystem } from './ShardSystem.js';

export const TARGET_SHARDS = 25;
const ROUND_RESET_DELAY_MS = 5000;

export class RoundController {
  private resetTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly world: World,
    private readonly worldState: WorldState,
    private readonly shardSystem: ShardSystem
  ) {}

  /** Start a new round: set RUNNING and announce. */
  startRound(): void {
    const r = this.worldState.roundState;
    r.status = 'RUNNING';
    r.winnerPlayerId = undefined;
    this.broadcast(`Round started. First to ${TARGET_SHARDS} shards wins.`);
  }

  /** Called when a player's shard total may have changed. */
  onPlayerShardsChanged(playerId: string): void {
    if (this.worldState.roundState.status !== 'RUNNING') return;

    const p = this.worldState.getPlayer(playerId);
    if (!p || p.shards < TARGET_SHARDS) return;

    this.endRound(playerId);
  }

  /** End round with winner; broadcast and schedule reset. */
  endRound(winnerPlayerId: string): void {
    const r = this.worldState.roundState;
    if (r.status !== 'RUNNING') return;

    r.status = 'ENDED';
    r.winnerPlayerId = winnerPlayerId;

    const winnerName = this.getPlayerDisplayName(winnerPlayerId);
    this.broadcast(`🏆 ${winnerName} wins! Resetting in 5 seconds...`);

    this.resetTimeoutId = setTimeout(() => {
      this.resetTimeoutId = null;
      this.resetRound();
    }, ROUND_RESET_DELAY_MS);
  }

  /** Reset match seed, clear pickups and respawn, reset shards, increment round, restart. */
  resetRound(): void {
    const r = this.worldState.roundState;
    r.status = 'RESETTING';

    if (this.resetTimeoutId != null) {
      clearTimeout(this.resetTimeoutId);
      this.resetTimeoutId = null;
    }

    const newMatchId = `match-${this.world.id}-${Date.now()}`;
    this.worldState.setMatchId(newMatchId);

    this.worldState.resetAllPlayerShards();
    this.shardSystem.regeneratePickups(this.worldState.seed);

    r.winnerPlayerId = undefined;
    r.roundId += 1;

    this.startRound();
  }

  /** Force reset and start (DEV_MODE use). */
  forceStart(): void {
    if (this.resetTimeoutId != null) {
      clearTimeout(this.resetTimeoutId);
      this.resetTimeoutId = null;
    }
    this.resetRound();
  }

  /** Send current round status to a specific joining player. */
  public sendRoundBannerToPlayer(player: Player): void {
    const rs = this.worldState.roundState;

    const winner = rs.winnerPlayerId
      ? ` winner=${this.getPlayerDisplayName(rs.winnerPlayerId)}`
      : '';

    this.world.chatManager.sendPlayerMessage(
      player,
      `Round ${rs.roundId} is ${rs.status}. Target=${TARGET_SHARDS}.${winner}`
    );
  }

  private broadcast(message: string): void {
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    for (const player of players) {
      this.world.chatManager.sendPlayerMessage(player, message);
    }
  }

  private getPlayerDisplayName(playerId: string): string {
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    const found = players.find(p => p.id === playerId);

    if (
      found &&
      'name' in found &&
      typeof (found as { name?: string }).name === 'string'
    ) {
      return (found as { name: string }).name;
    }

    return playerId;
  }
}
