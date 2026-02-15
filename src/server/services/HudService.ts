/**
 * Server-authoritative HUD: send state to UI via player.ui.sendData.
 * Only sends on state changes (no per-tick spam).
 */

import type { World, Player } from 'hytopia';
import { PlayerManager } from 'hytopia';
import type { WorldState } from '../state/WorldState.js';
import {
  HUD_MESSAGE_VERSION,
  type HudMessage,
  type HudObjectivePayload,
  type ToastMessage,
  type FeedMessage,
  type RoundSplashMessage,
} from '../schema/hudMessages.js';
import { TARGET_SHARDS } from '../constants.js';

export interface HudExtras {
  winnerName?: string;
  resetEndsAtMs?: number;
}

export class HudService {
  constructor(
    private readonly world: World,
    private readonly worldState: WorldState
  ) {}

  /**
   * Send current HUD state to one player.
   * Server-authoritative: derives values from worldState only.
   * Extras are allowed only for non-gameplay display fields (winnerName/reset timer).
   */
  sendHud(player: Player, extras?: HudExtras): void {
    const r = this.worldState.roundState;
    const p = this.worldState.getPlayer(player.id);
    const config = this.worldState.matchConfig;

    // Single source of truth
    const shards = p?.shards ?? 0;
    const healthPayload =
      p != null
        ? {
            current: p.health ?? 100,
            max: p.maxHealth ?? 100,
            ...(p.invulnerableUntilMs != null && { invulnerableUntilMs: p.invulnerableUntilMs }),
          }
        : null;

    const msg: HudMessage = {
      v: HUD_MESSAGE_VERSION,
      type: 'hud',
      shards,
      roundId: r.roundId,
      status: r.status,
      target: TARGET_SHARDS,
      roundStatus: r.status,
      matchEndsAtMs: r.matchEndsAtMs,
      resetEndsAtMs: r.resetEndsAtMs ?? extras?.resetEndsAtMs,
    };
    if (healthPayload != null) msg.health = healthPayload;
    msg.ambientScore = p?.ambientScore ?? 0;
    msg.effects = (p?.effects ?? []).map(e => ({ kind: e.kind, expiresAtMs: e.expiresAtMs }));

    msg.mode = config.mode;
    if (config.mode === 'survival') {
      const surv = this.worldState.survivalState;
      msg.timerMs = surv.status === 'RUNNING' ? surv.elapsedMs : 0;
      msg.score = surv.status === 'ENDED' ? surv.score : Math.floor(surv.elapsedMs / 1000) + surv.wave * 25 + surv.kills * 10 + Math.floor(surv.inObjectiveMs / 1000) * 2;
      msg.wave = surv.wave;
      msg.enemiesRemaining = surv.enemiesRemaining;
    } else if (config.mode === 'timetrial') {
      const tt = this.worldState.timeTrialState;
      msg.timerMs = tt.status === 'RUNNING' ? Date.now() - tt.startedAtMs : 0;
      msg.captureProgressPercent = tt.requiredCaptureMs > 0
        ? Math.min(100, Math.floor((tt.captureMs / tt.requiredCaptureMs) * 100))
        : 0;
      if (tt.status === 'ENDED') {
        msg.score = Math.max(0, 300000 - (Date.now() - tt.startedAtMs));
      }
    }

    if (config.mode === 'tower') {
      msg.carriedShards = p?.carriedShards ?? 0;
      msg.bankedShards = p?.bankedShards ?? 0;
      const ts = this.worldState.towerState;
      if (ts) {
        const tierThresholds = [8, 18, 30];
        const next = tierThresholds[ts.unlockedTier];
        msg.nextTierRequirement = next;
        msg.roofHoldMs = ts.roofHoldMs;
        msg.roofHoldTargetMs = 20000;
        msg.roofActive = ts.roofActive;
      }
    }

    if (r.winnerPlayerId != null) {
      // Winner display name from score store if present, else live player display name, else id.
      const entry = this.worldState.score.scoresByPlayerId[r.winnerPlayerId];
      msg.winnerName =
        extras?.winnerName ??
        entry?.name ??
        this.getPlayerDisplayName(r.winnerPlayerId);
    }

    const obj = this.worldState.objective;
    if (obj != null) {
      msg.objective = this.objectiveToPayload(obj);
    }

    // Leaderboard based on current round shards (same source as msg.shards)
    const leaderboard = this.getLeaderboard();
    if (leaderboard.length > 0) {
      msg.scores = leaderboard;
    }

    player.ui.sendData(msg);
  }

  /**
   * Leaderboard derived from WorldState (humans + bots).
   * Tower mode: score = bankedShards + carriedShards. Other modes: score = shards.
   * Sorted by score desc, then name asc.
   */
  private getLeaderboard(): Array<{ playerId: string; name: string; score: number }> {
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    const entries: Array<{ playerId: string; name: string; score: number }> = [];
    const isTower = this.worldState.matchConfig.mode === 'tower';

    for (const pl of players) {
      const p = this.worldState.getPlayer(pl.id);
      const name = this.getPlayerDisplayName(pl.id);
      const score = isTower
        ? (p?.bankedShards ?? 0) + (p?.carriedShards ?? 0)
        : (p?.shards ?? 0);
      entries.push({ playerId: pl.id, name, score });
    }
    for (const [botId, displayName] of this.worldState.botDisplayNames) {
      const p = this.worldState.getPlayer(botId);
      if (p) {
        const score = isTower
          ? (p.bankedShards ?? 0) + (p.carriedShards ?? 0)
          : p.shards;
        entries.push({ playerId: botId, name: displayName, score });
      }
    }
    return entries.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    });
  }

  private objectiveToPayload(obj: {
    kind: 'GOLDEN_APPLE';
    isActive: boolean;
    position: { x: number; y: number; z: number };
    respawnAtMs?: number;
  }): HudObjectivePayload {
    return {
      kind: obj.kind,
      isActive: obj.isActive,
      position: { ...obj.position },
      respawnAtMs: obj.respawnAtMs,
    };
  }

  /** Send current HUD state to all connected players. */
  broadcastHud(extras?: HudExtras): void {
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    for (const player of players) {
      this.sendHud(player, extras);
    }
  }

  toast(player: Player, kind: 'good' | 'info' | 'bad', message: string): void {
    const msg: ToastMessage = {
      v: HUD_MESSAGE_VERSION,
      type: 'toast',
      kind,
      message,
    };
    player.ui.sendData(msg);
  }

  broadcastToast(kind: 'good' | 'info' | 'bad', message: string): void {
    const msg: ToastMessage = {
      v: HUD_MESSAGE_VERSION,
      type: 'toast',
      kind,
      message,
    };
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    for (const player of players) {
      player.ui.sendData(msg);
    }
  }

  feed(player: Player, message: string): void {
    const msg: FeedMessage = {
      v: HUD_MESSAGE_VERSION,
      type: 'feed',
      message,
    };
    player.ui.sendData(msg);
  }

  broadcastFeed(message: string): void {
    const msg: FeedMessage = {
      v: HUD_MESSAGE_VERSION,
      type: 'feed',
      message,
    };
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    for (const player of players) {
      player.ui.sendData(msg);
    }
  }

  sendRoundSplashToPlayer(player: Player): void {
    const msg: RoundSplashMessage = {
      v: HUD_MESSAGE_VERSION,
      type: 'roundSplash',
      roundId: this.worldState.roundState.roundId,
    };
    player.ui.sendData(msg);
  }

  broadcastRoundSplash(): void {
    const msg: RoundSplashMessage = {
      v: HUD_MESSAGE_VERSION,
      type: 'roundSplash',
      roundId: this.worldState.roundState.roundId,
    };
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    for (const player of players) {
      player.ui.sendData(msg);
    }
  }

  private getPlayerDisplayName(playerId: string): string {
    const botName = this.worldState.botDisplayNames.get(playerId);
    if (botName) return botName;
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
}
