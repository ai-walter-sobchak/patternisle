/**
 * Server-authoritative state types for Patternisle.
 * Single source of truth; no persistence.
 */

/** Placeholder for fragment data (expand later). */
export interface Fragment {
  id: string;
  /** Add more fields as needed. */
}

/** Per-player stats tracked by the server. */
export interface PlayerStats {
  creaturesCreated: number;
  islandsDiscovered: number;
  hybridsCreated: number;
}

/** Server-side state for one player. */
export interface PlayerState {
  playerId: string;
  shards: number;
  unlockedTechniques: string[];
  fragments: Fragment[];
  stats: PlayerStats;
  /** True while player is in the world; false after LEFT_WORLD. */
  connected: boolean;
}

/** Round loop state: RUNNING → ENDED → RESETTING → RUNNING. */
export interface RoundState {
  roundId: number;
  status: 'RUNNING' | 'ENDED' | 'RESETTING';
  winnerPlayerId?: string;
  /** When status is ENDED, client countdown target (ms since epoch). */
  resetEndsAtMs?: number;
}
