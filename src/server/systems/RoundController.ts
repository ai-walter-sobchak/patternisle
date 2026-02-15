/**
 * Round loop: RUNNING → RESETTING → RUNNING.
 * Server-authoritative; safe with join/leave mid-round.
 */

import type { World, Player } from 'hytopia';
import { PlayerManager } from 'hytopia';
import type { WorldState } from '../state/WorldState.js';
import type { ScoreEntry } from '../state/types.js';
import type { ShardSystem } from './ShardSystem.js';
import type { PowerUpSystem } from './PowerUpSystem.js';
import type { ObjectiveSystem } from './ObjectiveSystem.js';
import type { SpawnSystem } from './SpawnSystem.js';
import type { HudService } from '../services/HudService.js';
import type { ScoreService } from '../services/ScoreService.js';
import { TARGET_SHARDS } from '../constants.js';
import { ARENA_BOUNDS } from '../config/arenaBounds.js';
import { ARENA_V1_TIMED_MATCH_ONLY } from '../config/arenaMode.js';
import { generateValidArena } from '../procgen/generateValidArena.js';
import { specToMap } from '../procgen/specToMap.js';
import { generateTheme } from '../procgen/themes.js';

export { TARGET_SHARDS };

const ROUND_RESET_DELAY_MS = 8000;
const POWERUP_SPAWN_COUNT = 12;

/** Numeric seed for this round so shards and powerups get new positions every round. */
function roundSeedNumeric(baseSeed: number, roundId: number): number {
  return (baseSeed + roundId * 7919) >>> 0;
}

export class RoundController {
  private startMatchInProgress = false;

  constructor(
    private readonly world: World,
    private readonly worldState: WorldState,
    private readonly shardSystem: ShardSystem,
    private readonly powerUpSystem: PowerUpSystem,
    private readonly objectiveSystem: ObjectiveSystem,
    private readonly spawnSystem: SpawnSystem,
    private readonly hud: HudService,
    private readonly scoreService: ScoreService
  ) {}

  /* -------------------------------------------------------------------------- */
  /* MATCH START                                                                */
  /* -------------------------------------------------------------------------- */

  /** Dev / command: start a match immediately (e.g. /forcestart, /start). */
  forceStart(): void {
    if (this.worldState.roundState.status === 'STARTING' || this.startMatchInProgress) return;
    this.beginStartMatch();
  }

  /**
   * Kick off round start: set STARTING, generate procgen map from round seed, load it, then finish start.
   */
  private beginStartMatch(): void {
    const r = this.worldState.roundState;
    if (r.status === 'STARTING' || this.startMatchInProgress) return;
    r.status = 'STARTING';
    this.startMatchInProgress = true;
    this.startMatchAsync().catch((err) => {
      console.error('[RoundController] startMatchAsync failed', err);
      r.status = 'RESETTING';
      this.startMatchInProgress = false;
    });
  }

  private async startMatchAsync(): Promise<void> {
    const r = this.worldState.roundState;
    const nextRoundId = r.roundId == null ? 1 : r.roundId + 1;
    const roundSeed = `${this.worldState.matchId}_r${nextRoundId}`;

    const { spec, usedSeed } = generateValidArena(roundSeed, 16);
    const theme = generateTheme(roundSeed);
    const map = specToMap(spec, theme);

    await this.world.loadMap(map);

    this.worldState.mapData = map;
    this.worldState.procgenSpec = spec;
    this.worldState.spawn.spawnPoints = [];
    this.worldState.spawn.lastSpawnIndexByPlayerId = {};

    if (usedSeed.startsWith('fallback')) {
      console.warn('[RoundController] round used fallback spec', { roundSeed, usedSeed });
    }

    this.finishStartMatch(nextRoundId);
    this.startMatchInProgress = false;
  }

  private finishStartMatch(roundId: number): void {
    const now = Date.now();
    const r = this.worldState.roundState;

    r.status = 'RUNNING';
    r.roundId = roundId;
    r.matchEndsAtMs = now + r.matchDurationMs;
    r.resetEndsAtMs = undefined;
    r.winnerPlayerId = undefined;

    const players = this.getMatchPlayers();

    for (const p of players) {
      this.scoreService.ensurePlayer(p.id, p.name);
    }

    this.scoreService.resetForPlayers(players);
    this.worldState.resetAllPlayerShards();

    const seedForRound = roundSeedNumeric(this.worldState.seed, roundId);
    this.shardSystem.resetForNewMatch(seedForRound);
    this.powerUpSystem.resetForNewRound(POWERUP_SPAWN_COUNT, seedForRound);

    this.ensureSpawnPoints();

    const connected = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    const playerPositions = this.getPlayerPositions(connected);

    for (const player of connected) {
      const pos = this.spawnSystem.getSpawnForPlayer(player.id, playerPositions);
      this.teleportPlayerTo(player, pos);
    }

    this.objectiveSystem.spawnObjectiveNow();

    this.hud.broadcastRoundSplash();
    this.hud.broadcastHud();
  }

  /** Called by tick when RESETTING delay has elapsed; kicks off async map load then match start. */
  startMatch(): void {
    this.beginStartMatch();
  }

  /* -------------------------------------------------------------------------- */
  /* MATCH END (TIMER OR OBJECTIVE)                                             */
  /* -------------------------------------------------------------------------- */

  endMatch(winnerPlayerId?: string): void {
    const r = this.worldState.roundState;
    if (r.status !== 'RUNNING') return;

    const now = Date.now();

    let winnerId = winnerPlayerId;

    if (!winnerId) {
      const leaderboard = this.getLeaderboard();
      winnerId = leaderboard.length > 0 ? leaderboard[0].playerId : undefined;
    }

    r.status = 'RESETTING';
    r.winnerPlayerId = winnerId;
    r.resetEndsAtMs = now + ROUND_RESET_DELAY_MS;

    this.hud.broadcastHud();

    if (winnerId) {
      const winnerName = this.getPlayerDisplayName(winnerId);
      this.hud.broadcastToast('good', `${winnerName} wins`);
      this.hud.broadcastFeed(`Winner: ${winnerName}`);
    } else {
      this.hud.broadcastToast('info', 'Match over');
      this.hud.broadcastFeed('No winner this round.');
    }
  }

  /* -------------------------------------------------------------------------- */
  /* TICK LOOP                                                                  */
  /* -------------------------------------------------------------------------- */

  tickMatchLifecycle(): void {
    const now = Date.now();
    const r = this.worldState.roundState;

    if (r.status === 'RUNNING' && r.matchEndsAtMs && now >= r.matchEndsAtMs) {
      this.endMatch();
    }

    if (r.status === 'RESETTING' && r.resetEndsAtMs && now >= r.resetEndsAtMs) {
      this.startMatch();
    }
  }

  /* -------------------------------------------------------------------------- */
  /* SHARD WIN CHECK                                                            */
  /* -------------------------------------------------------------------------- */

  onPlayerShardsChanged(playerId: string): void {
    if (this.worldState.roundState.status !== 'RUNNING') return;

    const p = this.worldState.getPlayer(playerId);
    if (!p || p.shards < TARGET_SHARDS) return;

    const name = this.getPlayerDisplayName(playerId);

    if (ARENA_V1_TIMED_MATCH_ONLY) {
      this.scoreService.addPoint(playerId, name, 1, 'objective');
      this.hud.broadcastToast('good', `${name} collected all shards! +1`);
      this.hud.broadcastFeed(`${name} completed the objective`);
      this.hud.broadcastHud();
      return;
    }

    this.endMatch(playerId);
  }

  /**
   * Returns a spawn position for a player joining the world (e.g. late-join).
   * Uses existing spawn logic and raycast for ground Y.
   */
  getSpawnPositionForNewPlayer(playerId: string): { x: number; y: number; z: number } {
    this.ensureSpawnPoints();
    const connected = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    const playerPositions = this.getPlayerPositions(connected);
    const pos = this.spawnSystem.getSpawnForPlayer(playerId, playerPositions);

    const origin = { x: pos.x, y: 50, z: pos.z };
    const direction = { x: 0, y: -1, z: 0 };
    const hit = this.world.simulation.raycast(origin, direction, 200);
    const y = hit ? hit.hitPoint.y + 4 : 5;

    return { x: pos.x, y, z: pos.z };
  }

  /* -------------------------------------------------------------------------- */
  /* RESPAWN                                                                    */
  /* -------------------------------------------------------------------------- */

  respawnPlayer(player: Player): void {
    const connected = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    const playerPositions = this.getPlayerPositions(connected);
    const pos = this.spawnSystem.getSpawnForPlayer(player.id, playerPositions);
    this.teleportPlayerTo(player, pos);
  }

  /* -------------------------------------------------------------------------- */
  /* HELPERS                                                                    */
  /* -------------------------------------------------------------------------- */

  private ensureSpawnPoints(): void {
    if (this.worldState.spawn.spawnPoints.length > 0) return;

    // Procgen maps: use spec spawn zones so players spawn inside the arena pads, not on the outer edge
    if (this.worldState.procgenSpec) {
      this.spawnSystem.buildSpawnPointsFromProcgenSpec(this.worldState.procgenSpec, 16);
      return;
    }

    if (this.worldState.mapData) {
      this.spawnSystem.buildSurfaceSpawnPointsFromMap(
        this.worldState.mapData,
        16,
        2
      );
    }

    if (this.worldState.spawn.spawnPoints.length === 0) {
      this.spawnSystem.buildPerimeterSpawnPoints(ARENA_BOUNDS, 16);
    }
  }

  private getMatchPlayers(): { id: string; name: string }[] {
    const ids = Array.from(this.worldState.players.keys());
    const connected = PlayerManager.instance.getConnectedPlayersByWorld(this.world);

    return ids.map(id => {
      const found = connected.find(p => p.id === id);
      return {
        id,
        name: found && 'name' in found ? (found as any).name : id
      };
    });
  }

  private getLeaderboard(): ScoreEntry[] {
    return Object.values(this.worldState.score.scoresByPlayerId)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  private getPlayerDisplayName(playerId: string): string {
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    const found = players.find(p => p.id === playerId);
    return found && 'name' in found ? (found as any).name : playerId;
  }

  private getPlayerPositions(players: Player[]) {
    const out: any[] = [];
    for (const player of players) {
      const entities = this.world.entityManager.getPlayerEntitiesByPlayer(player);
      const entity = entities[0];
      if (entity?.isSpawned) {
        const p = entity.position;
        out.push({ playerId: player.id, position: { x: p.x, y: p.y, z: p.z } });
      }
    }
    return out;
  }

  private teleportPlayerTo(
    player: Player,
    pos: { x: number; y: number; z: number }
  ): void {
    const origin = { x: pos.x, y: 50, z: pos.z };
    const direction = { x: 0, y: -1, z: 0 };
    const hit = this.world.simulation.raycast(origin, direction, 200);

    pos.y = hit ? hit.hitPoint.y + 4 : 5;

    const entities = this.world.entityManager.getPlayerEntitiesByPlayer(player);
    const entity = entities[0];
    if (entity?.isSpawned) {
      entity.setPosition(pos);
    }
  }
}
