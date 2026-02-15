/**
 * Server-authoritative scoring (Phase 5C). Writes to worldState.score.
 * Does not end the match; winner computed in Phase 5D.
 */

import type { ScoreEntry } from '../state/types.js';
import type { WorldState } from '../state/WorldState.js';

export type ScoreReason = 'objective' | 'kill' | 'assist' | 'other';

export class ScoreService {
  constructor(private readonly worldState: WorldState) {}

  /** Creates ScoreEntry if missing with score=0. */
  ensurePlayer(playerId: string, name: string): ScoreEntry {
    const { scoresByPlayerId } = this.worldState.score;
    let entry = scoresByPlayerId[playerId];
    if (!entry) {
      entry = { playerId, name, score: 0 };
      scoresByPlayerId[playerId] = entry;
    } else {
      entry.name = name;
    }
    return entry;
  }

  /** Clears score state and ensures all players exist with score 0. */
  resetForPlayers(players: Array<{ id: string; name: string }>): void {
    if (!players?.length) {
      console.warn('[score] resetForPlayers called with 0 players; skipping reset');
      return;
    }
    this.worldState.score = {
      scoresByPlayerId: {},
      lastEventAtMs: undefined,
    };
    for (const { id, name } of players) {
      this.ensurePlayer(id, name);
    }
  }

  /**
   * Add points to a player. Updates worldState.score; does not end the match.
   * Backward compat: also sets player.objectivePoints = entry.score (removed after 5D).
   */
  addPoint(
    playerId: string,
    name: string,
    amount: number,
    _reason: ScoreReason
  ): ScoreEntry {
    this.ensurePlayer(playerId, name);
    const entry = this.worldState.score.scoresByPlayerId[playerId]!;
    const now = Date.now();
    entry.score += amount;
    entry.lastScoreAtMs = now;
    this.worldState.score.lastEventAtMs = now;

    const player = this.worldState.getPlayer(playerId);
    if (player) player.objectivePoints = entry.score;

    return entry;
  }
}
