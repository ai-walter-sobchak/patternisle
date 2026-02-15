/**
 * Server-authoritative WorldState: single source of truth per match.
 * Match identity and deterministic seed are set once per match (session); no persistence.
 */

import type { PlayerState, RoundState } from './types.js';

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
    status: 'RUNNING',
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
        unlockedTechniques: [],
        fragments: [],
        stats: {
          creaturesCreated: 0,
          islandsDiscovered: 0,
          hybridsCreated: 0,
        },
        connected: true,
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
}
