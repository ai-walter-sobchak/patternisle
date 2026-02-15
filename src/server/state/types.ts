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

/** Per-player score entry (Phase 5C). Server-owned score state. */
export type ScoreEntry = {
  playerId: string;
  name: string;
  score: number;
  lastScoreAtMs?: number;
};

/** Match score state: per-player scores; supports join mid-round. */
export type ScoreState = {
  scoresByPlayerId: Record<string, ScoreEntry>;
  lastEventAtMs?: number;
};

/** Golden Apple objective state (Phase 5A). Server-authoritative. */
export interface ObjectiveState {
  id: string;
  kind: 'GOLDEN_APPLE';
  position: { x: number; y: number; z: number };
  isActive: boolean;
  claimedByPlayerId?: string;
  claimedAtMs?: number;
  respawnAtMs?: number;
}

/** Server-side state for one player. */
export interface PlayerState {
  playerId: string;
  shards: number;
  /** @deprecated Use worldState.score (Phase 5C). Kept for UI/debug until 5D. */
  objectivePoints: number;
  unlockedTechniques: string[];
  fragments: Fragment[];
  stats: PlayerStats;
  /** True while player is in the world; false after LEFT_WORLD. */
  connected: boolean;
  /** If set, inputs are locked until this time (ms since epoch); e.g. during RESETTING. */
  controlsLockedUntilMs?: number;
}

/** Round loop state: LOBBY → RUNNING → ENDED → RESETTING → RUNNING. */
export interface RoundState {
  roundId: number;
  status: 'LOBBY' | 'RUNNING' | 'ENDED' | 'RESETTING';
  winnerPlayerId?: string;
  /** Match duration in ms (default 180000). */
  matchDurationMs: number;
  /** When match timer ends (ms since epoch); set when RUNNING. */
  matchEndsAtMs?: number;
  /** When status is ENDED, client countdown target (ms since epoch). */
  resetEndsAtMs?: number;
}

/** Single spawn point in world space. */
export type SpawnPoint = { x: number; y: number; z: number };

/** Spawn system state: perimeter points and last-used index per player. */
export type SpawnState = {
  spawnPoints: SpawnPoint[];
  lastSpawnIndexByPlayerId: Record<string, number>;
};

/** Map data (e.g. from assets/map.json) for floor-aware spawn generation. blocks keyed by "x,y,z". */
export type MapData = { blocks?: Record<string, unknown> };
