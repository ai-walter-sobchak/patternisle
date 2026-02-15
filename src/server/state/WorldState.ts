/**
 * Server-authoritative WorldState: single source of truth per match.
 * Match identity and deterministic seed are set once per match (session); no persistence.
 */

import type {
  MapData,
  ObjectiveState,
  PlayerState,
  PowerUpState,
  RoundState,
  ScoreState,
  SpawnState,
} from './types.js';
import type { MapSpecV1 } from '../procgen/spec.js';
import type { MatchConfig } from '../modes/types.js';
import { DEFAULT_MATCH_CONFIG } from './matchConfig.js';
import { INITIAL_SURVIVAL_STATE, type SurvivalState } from './survivalState.js';
import { INITIAL_TIME_TRIAL_STATE, type TimeTrialState } from './timeTrialState.js';

/** Salt used when deriving seed from matchId. Changing this changes all derived seeds. */
const SEED_SALT = 'patternisle-match-v1';

/**
 * Stable string hash to a 32-bit signed integer seed.
 * Same input always produces the same output (deterministic).
 * Uses a djb2-like algorithm; overflow is intentional to get 32-bit range.
 *
 * @param str - Input string (e.g. matchId + salt)
 * @returns 32-bit integer suitable for use as a PRNG seed
 */
export function stringToSeed(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

export class WorldState {
  matchId: string;
  seed: number;
  readonly players: Map<string, PlayerState> = new Map();
  /** Round loop state; managed by RoundController. */
  roundState: RoundState = {
    roundId: 0,
    status: 'LOBBY',
    mode: 'SOLO',
    targetShards: 25,
    matchDurationMs: 180000,
  };

  /** Current arena objective (Golden Apple); null when none. */
  objective: ObjectiveState | null = null;

  /** Map data for floor-aware spawns; set from index after load (optional). */
  mapData: MapData | null = null;

  /** When set by /seed (dev) or at match start, the generated procgen spec for this match. */
  procgenSpec: MapSpecV1 | null = null;

  /** Same as procgenSpec; set together for procgen integration. */
  mapSpec: MapSpecV1 | null = null;

  /** Seed actually used for last procgen (may differ from config seed after retries). */
  usedSeed: string = '';

  /** Attempt index (1-based) for last successful procgen. */
  procgenAttempt: number = 0;

  /** Match config (mode, size, survival/timetrial params). Loaded at startup. */
  matchConfig: MatchConfig = { ...DEFAULT_MATCH_CONFIG };

  /** Solo Survival mode state. */
  survivalState: SurvivalState = { ...INITIAL_SURVIVAL_STATE };

  /** Solo Time Trial mode state. */
  timeTrialState: TimeTrialState = { ...INITIAL_TIME_TRIAL_STATE };

  /** Spawn points and last-used index per player; managed by SpawnSystem. */
  spawn: SpawnState = {
    spawnPoints: [],
    lastSpawnIndexByPlayerId: {},
  };

  /** Per-match scores; managed by ScoreService. Supports join mid-round. */
  score: ScoreState = {
    scoresByPlayerId: {},
  };

  /** Power-up spawns and pacing; managed by power-up system. */
  powerUps: PowerUpState = {
    spawnsById: {},
    maxActive: 10,
    respawnMinMs: 4000,
    respawnMaxMs: 9000,
  };

  constructor(matchId: string) {
    this.matchId = matchId;
    this.seed = stringToSeed(matchId + SEED_SALT);
  }

  /** Dev-only: set match id and recompute seed (same derivation as ctor). */
  setMatchId(newMatchId: string): void {
    this.matchId = newMatchId;
    this.seed = stringToSeed(newMatchId + SEED_SALT);
  }

  /** True if any player is currently connected (in world). */
  hasConnectedPlayers(): boolean {
    for (const p of this.players.values()) if (p.connected) return true;
    return false;
  }

  /** Get or create player state; marks connected. */
  registerPlayer(playerId: string): PlayerState {
    let state = this.players.get(playerId);
    if (!state) {
      state = {
        playerId,
        shards: 0,
        objectivePoints: 0,
        unlockedTechniques: [],
        fragments: [],
        stats: {
          creaturesCreated: 0,
          islandsDiscovered: 0,
          hybridsCreated: 0,
        },
        connected: true,
        health: 100,
      };
      this.players.set(playerId, state);
    } else {
      state.connected = true;
    }
    return state;
  }

  /** Mark player as disconnected (do not remove from map). */
  disconnectPlayer(playerId: string): void {
    const state = this.players.get(playerId);
    if (state) state.connected = false;
  }

  getPlayer(playerId: string): PlayerState | undefined {
    return this.players.get(playerId);
  }

  /** Set every player's shard balance to 0 (round reset). Does not remove players. */
  resetAllPlayerShards(): void {
    for (const p of this.players.values()) {
      p.shards = 0;
    }
  }

  /** Set a single player's shard balance to 0 (e.g. late-join). */
  resetPlayerShards(playerId: string): void {
    const ps = this.getPlayer(playerId);
    if (!ps) return;
    ps.shards = 0;
  }
}
