/**
 * UI message schema (v1). Single source of truth for server → UI via player.ui.sendData / hytopia.onData.
 * Only send on state changes; no per-tick spam.
 */

export const HUD_MESSAGE_VERSION = 1;

export type HudRoundStatus = 'LOBBY' | 'RUNNING' | 'ENDED' | 'RESETTING';

/** Objective snippet for HUD (Golden Apple). */
export interface HudObjectivePayload {
  kind: 'GOLDEN_APPLE';
  isActive: boolean;
  position: { x: number; y: number; z: number };
  respawnAtMs?: number;
}

/** Leaderboard entry sent to UI (name + score). */
export interface HudScoreEntry {
  playerId: string;
  name: string;
  score: number;
}

export interface HudMessage {
  v: typeof HUD_MESSAGE_VERSION;
  type: 'hud';
  shards: number;
  roundId: number;
  status: HudRoundStatus;
  target: number;
  /** Round phase for countdown UI. */
  roundStatus?: HudRoundStatus;
  /** When match timer ends (ms since epoch). */
  matchEndsAtMs?: number;
  /** When reset countdown ends (ms since epoch). */
  resetEndsAtMs?: number;
  winnerName?: string;
  objective?: HudObjectivePayload;
  /** Leaderboard (sorted by score desc, name asc). */
  scores?: HudScoreEntry[];
  /** Local player health (sent only to that player). */
  health?: number;
  /** Ambient power-up score (sent only to that player). */
  ambientScore?: number;
  /** Active power-up effects with expiry (sent only to that player). */
  effects?: Array<{ kind: string; expiresAtMs: number }>;
}

export interface ToastMessage {
  v: typeof HUD_MESSAGE_VERSION;
  type: 'toast';
  kind: 'good' | 'info' | 'bad';
  message: string;
}

export interface FeedMessage {
  v: typeof HUD_MESSAGE_VERSION;
  type: 'feed';
  message: string;
}

export interface RoundSplashMessage {
  v: typeof HUD_MESSAGE_VERSION;
  type: 'roundSplash';
  roundId: number;
}

export type UiMessage = HudMessage | ToastMessage | FeedMessage | RoundSplashMessage;
