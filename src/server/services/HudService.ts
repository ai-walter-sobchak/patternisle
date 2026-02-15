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
  type ToastMessage,
  type FeedMessage,
  type RoundSplashMessage,
} from '../schema/hudMessages.js';
import { TARGET_SHARDS } from '../constants.js';

export interface HudExtras {
  shards?: number;
  winnerName?: string;
  resetEndsAtMs?: number;
}

export class HudService {
  constructor(
    private readonly world: World,
    private readonly worldState: WorldState
  ) {}

  /** Send current HUD state to one player. Uses server state; extras override for that payload only. */
  sendHud(player: Player, extras?: HudExtras): void {
    const r = this.worldState.roundState;
    const p = this.worldState.getPlayer(player.id);
    const shards = extras?.shards ?? p?.shards ?? 0;

    const msg: HudMessage = {
      v: HUD_MESSAGE_VERSION,
      type: 'hud',
      shards,
      roundId: r.roundId,
      status: r.status,
      target: TARGET_SHARDS,
    };
    if (r.winnerPlayerId != null) {
      msg.winnerName =
        extras?.winnerName ?? this.getPlayerDisplayName(r.winnerPlayerId);
    }
    if (r.resetEndsAtMs != null || extras?.resetEndsAtMs != null) {
      msg.resetEndsAtMs = extras?.resetEndsAtMs ?? r.resetEndsAtMs;
    }

    player.ui.sendData(msg);
  }

  /** Send current HUD state to all connected players. */
  broadcastHud(extras?: HudExtras): void {
    const players = PlayerManager.instance.getConnectedPlayersByWorld(
      this.world
    );
    for (const player of players) {
      const p = this.worldState.getPlayer(player.id);
      const playerExtras: HudExtras | undefined =
        extras ?? (p != null ? { shards: p.shards } : undefined);
      this.sendHud(player, playerExtras);
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

  broadcastToast(
    kind: 'good' | 'info' | 'bad',
    message: string
  ): void {
    const msg: ToastMessage = {
      v: HUD_MESSAGE_VERSION,
      type: 'toast',
      kind,
      message,
    };
    const players = PlayerManager.instance.getConnectedPlayersByWorld(
      this.world
    );
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
    const players = PlayerManager.instance.getConnectedPlayersByWorld(
      this.world
    );
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
    const players = PlayerManager.instance.getConnectedPlayersByWorld(
      this.world
    );
    for (const player of players) {
      player.ui.sendData(msg);
    }
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
}
