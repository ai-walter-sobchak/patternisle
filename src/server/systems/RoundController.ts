/**
 * Round loop: LOBBY → startMatch (RUNNING) → endMatch (RESETTING) → resetMatch → startMatch.
 * Server-authoritative; safe with join/leave mid-round.
 */

import type { World, Player } from 'hytopia';
import { PlayerManager } from 'hytopia';
import type { WorldState } from '../state/WorldState.js';
import type { ScoreEntry } from '../state/types.js';
import type { ShardSystem } from './ShardSystem.js';
import type { ObjectiveSystem } from './ObjectiveSystem.js';
import type { SpawnSystem } from './SpawnSystem.js';
import type { HudService } from '../services/HudService.js';
import type { ScoreService } from '../services/ScoreService.js';
import { TARGET_SHARDS } from '../constants.js';
import { ARENA_BOUNDS } from '../config/arenaBounds.js';
import { ARENA_V1_TIMED_MATCH_ONLY } from '../config/arenaMode.js';

export { TARGET_SHARDS };

/** Single constant for match reset timing (timer end → RESETTING countdown → resetMatch). */
const ROUND_RESET_DELAY_MS = 8000;

export class RoundController {
  private resetTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly world: World,
    private readonly worldState: WorldState,
    private readonly shardSystem: ShardSystem,
    private readonly objectiveSystem: ObjectiveSystem,
    private readonly spawnSystem: SpawnSystem,
    private readonly hud: HudService,
    private readonly scoreService: ScoreService
  ) {}

  /** Returns all players in the match from WorldState (source of truth for scoreboard). */
  getMatchPlayers(): { id: string; name: string }[] {
    const ids = Array.from(this.worldState.players.keys());
    const connected = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    return ids.map((id) => {
      const pmPlayer = connected.find((p) => p.id === id);
      const name =
        pmPlayer && 'name' in pmPlayer && typeof (pmPlayer as { name?: string }).name === 'string'
          ? (pmPlayer as { name: string }).name
          : (this.worldState.getPlayer(id) as { name?: string } | undefined)?.name ?? id;
      return { id, name };
    });
  }

  /** Returns all connected players in the match (same source as teleport/spawn). */
  getConnectedPlayers(): Array<{ id: string; name: string; entity?: unknown }> {
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    return players.map((player) => {
      const entities = this.world.entityManager.getPlayerEntitiesByPlayer(player);
      const entity = entities[0];
      const name =
        player && 'name' in player && typeof (player as { name?: string }).name === 'string'
          ? (player as { name: string }).name
          : player.id;
      return { id: player.id, name, entity };
    });
  }

  /** Leaderboard from worldState.score, sorted by score desc, then name asc. */
  getLeaderboard(): ScoreEntry[] {
    const { scoresByPlayerId } = this.worldState.score;
    return Object.values(scoresByPlayerId).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    });
  }

  /** Start a new match: set RUNNING, reset scores, teleport, spawn objective, broadcast splash + HUD. */
  startMatch(): void {
    const now = Date.now();
    const r = this.worldState.roundState;
    r.status = 'RUNNING';
    r.matchEndsAtMs = now + r.matchDurationMs;
    r.resetEndsAtMs = undefined;
    r.winnerPlayerId = undefined;
    r.roundId = r.roundId == null ? 1 : r.roundId + 1;

    const matchPlayers = this.getMatchPlayers();
    console.log('[round] startMatch matchPlayers', matchPlayers);
    for (const p of matchPlayers) this.scoreService.ensurePlayer(p.id, p.name);
    this.scoreService.resetForPlayers(matchPlayers);
    this.worldState.resetAllPlayerShards();

    for (const p of matchPlayers) {
      const ps = this.worldState.getPlayer(p.id);
      if (ps) {
        delete ps.controlsLockedUntilMs;
        ps.health = 100;
      }
    }

    this.shardSystem.resetForNewMatch(this.worldState.seed);

    if (this.worldState.spawn.spawnPoints.length === 0) {
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

    const connectedPlayers = PlayerManager.instance.getConnectedPlayersByWorld(
      this.world
    );
    const playerPositions = this.getPlayerPositions(connectedPlayers);
    for (const player of connectedPlayers) {
      const pos = this.spawnSystem.getSpawnForPlayer(player.id, playerPositions);
      this.teleportPlayerTo(player, pos);
    }

    this.objectiveSystem.spawnObjectiveNow();
    this.hud.broadcastRoundSplash();
    this.hud.broadcastHud();
  }

  /** End match: compute winner from score, set RESETTING, broadcast toast/feed/HUD. */
  endMatch(): void {
    const now = Date.now();
    const r = this.worldState.roundState;
    r.status = 'ENDED';
    const leaderboard = this.getLeaderboard();
    const winner = leaderboard.length > 0 ? leaderboard[0] : undefined;
    r.winnerPlayerId = winner?.playerId;
    r.resetEndsAtMs = now + ROUND_RESET_DELAY_MS;
    r.status = 'RESETTING';

    const connected = this.getConnectedPlayers();
    for (const { id } of connected) {
      const playerState = this.worldState.getPlayer(id);
      if (playerState) playerState.controlsLockedUntilMs = r.resetEndsAtMs;
    }

    this.hud.broadcastToast(
      'info',
      winner ? `Match over! Winner: ${winner.name}` : 'Match over!'
    );
    this.hud.broadcastFeed(winner ? `Winner: ${winner.name}` : 'No contest.');
    this.hud.broadcastHud();
  }

  /** Clear objective, then startMatch() (single authority for spawns, teleport, objective, HUD). */
  resetMatch(): void {
    this.worldState.objective = null;
    this.startMatch();
  }

  /** Call from game loop: advance match lifecycle (timer end → endMatch; reset delay → resetMatch). */
  tickMatchLifecycle(): void {
    const now = Date.now();
    const r = this.worldState.roundState;
    if (r.status === 'RUNNING' && r.matchEndsAtMs != null && now >= r.matchEndsAtMs) {
      this.endMatch();
    }
    if (
      r.status === 'RESETTING' &&
      r.resetEndsAtMs != null &&
      now >= r.resetEndsAtMs
    ) {
      this.resetMatch();
    }
  }

  /** Respawn a player at a safe perimeter spawn (e.g. after death). */
  respawnPlayer(player: Player): void {
    const connectedPlayers = PlayerManager.instance.getConnectedPlayersByWorld(
      this.world
    );
    const playerPositions = this.getPlayerPositions(connectedPlayers);
    const pos = this.spawnSystem.getSpawnForPlayer(player.id, playerPositions);
    this.teleportPlayerTo(player, pos);
  }

  /** Get spawn position for a player joining the world (spawn points built if needed). */
  getSpawnPositionForNewPlayer(playerId: string): { x: number; y: number; z: number } {
    if (this.worldState.spawn.spawnPoints.length === 0) {
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
    const connectedPlayers = PlayerManager.instance.getConnectedPlayersByWorld(
      this.world
    );
    const playerPositions = this.getPlayerPositions(connectedPlayers);
    return this.spawnSystem.getSpawnForPlayer(playerId, playerPositions);
  }

  /** Called when a player's shard total may have changed. */
  onPlayerShardsChanged(playerId: string): void {
    if (this.worldState.roundState.status !== 'RUNNING') return;

    const p = this.worldState.getPlayer(playerId);
    if (!p || p.shards < TARGET_SHARDS) return;

    if (ARENA_V1_TIMED_MATCH_ONLY) {
      // In Arena v1, shard/objective events award points only; match timer ends the round.
      const name = this.getPlayerDisplayName(playerId);
      this.scoreService.addPoint(playerId, name, 1, 'other');
      this.hud.broadcastToast('good', `${name} collected all shards! +1`);
      this.hud.broadcastFeed(`${name} collected all shards!`);
      this.hud.broadcastHud();
      return;
    }

    this.endRound(playerId);
  }

  /** End round with winner; broadcast HUD (winnerName, resetEndsAtMs), toast, schedule reset. */
  endRound(winnerPlayerId: string): void {
    const r = this.worldState.roundState;
    if (r.status !== 'RUNNING') return;

    r.status = 'ENDED';
    r.winnerPlayerId = winnerPlayerId;
    r.resetEndsAtMs = Date.now() + ROUND_RESET_DELAY_MS;

    this.hud.broadcastHud();
    const winnerName = this.getPlayerDisplayName(winnerPlayerId);
    this.hud.broadcastToast('good', `${winnerName} wins`);
    this.broadcast(`🏆 ${winnerName} wins! Resetting in ${ROUND_RESET_DELAY_MS / 1000} seconds...`);

    this.resetTimeoutId = setTimeout(() => {
      this.resetTimeoutId = null;
      this.resetRound();
    }, ROUND_RESET_DELAY_MS);
  }

  /** Reset match seed, clear pickups and respawn, reset shards, then startMatch (roundId incremented there). */
  resetRound(): void {
    const r = this.worldState.roundState;
    r.status = 'RESETTING';
    r.resetEndsAtMs = undefined;
    this.hud.broadcastHud();

    if (this.resetTimeoutId != null) {
      clearTimeout(this.resetTimeoutId);
      this.resetTimeoutId = null;
    }

    const newMatchId = `match-${this.world.id}-${Date.now()}`;
    this.worldState.setMatchId(newMatchId);

    this.worldState.resetAllPlayerShards();

    r.winnerPlayerId = undefined;

    this.startMatch();
  }

  /** Force reset and start (DEV_MODE use). */
  forceStart(): void {
    if (this.resetTimeoutId != null) {
      clearTimeout(this.resetTimeoutId);
      this.resetTimeoutId = null;
    }
    this.resetRound();
  }

  /** Send current round HUD + splash to a joining player (call from index after hud.sendHud if desired). */
  public sendRoundBannerToPlayer(player: Player): void {
    this.hud.sendHud(player);
    this.hud.sendRoundSplashToPlayer(player);
  }

  private broadcast(message: string): void {
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    for (const player of players) {
      this.world.chatManager.sendPlayerMessage(player, message);
    }
  }

  private getPlayerDisplayName(playerId: string): string {
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    const found = players.find(p => p.id === playerId);

    if (
      found &&
      'name' in found &&
      typeof (found as { name?: string }).name === 'string'
    ) {
      return (found as { name: string }).name;
    }

    return playerId;
  }

  private getPlayerPositions(players: Player[]): { playerId: string; position: { x: number; y: number; z: number } }[] {
    const out: { playerId: string; position: { x: number; y: number; z: number } }[] = [];
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

  /** Count of spawns that have logged ground hit (dev only, first few). */
  private spawnGroundLogCount = 0;
  private static readonly SPAWN_GROUND_LOG_LIMIT = 5;

  private teleportPlayerTo(
    player: Player,
    pos: { x: number; y: number; z: number }
  ): void {
    const origin = { x: pos.x, y: 50, z: pos.z };
    const direction = { x: 0, y: -1, z: 0 };
    const length = 200;
    const hit = this.world.simulation.raycast(origin, direction, length);

    if (hit) {
      pos.y = hit.hitPoint.y + 4; // land above surface (player height safety)
      if (this.spawnGroundLogCount < RoundController.SPAWN_GROUND_LOG_LIMIT) {
        this.spawnGroundLogCount++;
        const hitType = 'type' in hit ? (hit as { type?: string }).type : undefined;
        console.log('[spawn] ground hit', {
          x: pos.x,
          z: pos.z,
          hitY: hit.hitPoint.y,
          type: hitType,
        });
      }
    } else {
      console.warn('[spawn] no ground hit at', { x: pos.x, z: pos.z });
      pos.y = 5;
    }

    const entities = this.world.entityManager.getPlayerEntitiesByPlayer(player);
    const entity = entities[0];
    if (entity?.isSpawned) {
      entity.setPosition(pos);
    }
  }
}
