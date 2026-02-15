/**
 * UI message schema (v1). Single source of truth for server → UI via player.ui.sendData / hytopia.onData.
 * Only send on state changes; no per-tick spam.
 */

export const HUD_MESSAGE_VERSION = 1;

export type HudRoundStatus = 'RUNNING' | 'ENDED' | 'RESETTING';

export interface HudMessage {
  v: typeof HUD_MESSAGE_VERSION;
  type: 'hud';
  shards: number;
  roundId: number;
  status: HudRoundStatus;
  target: number;
  winnerName?: string;
  resetEndsAtMs?: number;
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
