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
  /** Combat: current health (default 100). */
  health: number;
  /** When this player was last damaged (ms since epoch). */
  lastDamagedAtMs?: number;
  /** Player who last damaged this player. */
  lastDamagedByPlayerId?: string;
  /** Optional: lockout until this time (ms) after KO before respawn. */
  isEliminatedUntilMs?: number;
  /** Melee cooldown: next attack allowed at or after this time (ms since epoch). */
  lastAttackAtMs?: number;
  /** Spawn protection: no damage until this time (ms since epoch). */
  invulnerableUntilMs?: number;
  /** Fall recovery: last time we recovered this player from void (ms since epoch); 2s cooldown. */
  lastFallRecoveryAtMs?: number;
}

/** Match mode selection. */
export type MatchMode = 'AUTO' | 'SOLO' | 'MULTI';

/** Solo result state when timer ends (or player reaches target). */
export type SoloResult = 'WIN' | 'LOSE';

/**
 * Round loop state:
 * LOBBY → STARTING → RUNNING → ENDED → RESETTING → LOBBY (or RUNNING depending on your flow).
 *
 * Note: Keeping your original statuses but adding STARTING for the 3s countdown.
 */
export interface RoundState {
  roundId: number;
  status: 'LOBBY' | 'STARTING' | 'RUNNING' | 'ENDED' | 'RESETTING';

  /** Mode chosen for the current round. */
  mode: MatchMode;

  /** Winner (MULTI) or player who met win condition first (SOLO). */
  winnerPlayerId?: string;

  /**
   * Target shards for the current round.
   * For MULTI: race to target.
   * For SOLO: hit target before timer ends.
   */
  targetShards: number;

  /** Match duration in ms (default 180000). */
  matchDurationMs: number;

  /** When match timer ends (ms since epoch); set when RUNNING. */
  matchEndsAtMs?: number;

  /** When status is STARTING, countdown ends at this time (ms since epoch). */
  startingEndsAtMs?: number;

  /** When status is ENDED/RESETTING, client countdown target (ms since epoch). */
  resetEndsAtMs?: number;

  /** SOLO: server-generated rival pace (display only). */
  rivalShards?: number;

  /** SOLO: final result for the local player is computed client-side using winner/lose semantics, but server can provide this summary. */
  soloResult?: SoloResult;
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
