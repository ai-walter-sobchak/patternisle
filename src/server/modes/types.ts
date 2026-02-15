/**
 * Game mode contract: only one mode is active per match.
 */

export type GameMode = 'survival' | 'timetrial' | 'bot_ffa' | 'koth' | 'tdm';

export interface MatchConfig {
  seed: string;
  mode: GameMode;
  size: number;
  survival: {
    winWaves: number;
    winSeconds: number;
    interWaveDelayMs: number;
  };
  timetrial: {
    requiredCaptureMs: number;
  };
}
