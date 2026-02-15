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
import type { BotManager } from './BotManager.js';
import { TARGET_SHARDS } from '../constants.js';
import { ARENA_BOUNDS } from '../config/arenaBounds.js';
import { ARENA_V1_TIMED_MATCH_ONLY } from '../config/arenaMode.js';
import { generateValidArena } from '../procgen/generateValidArena.js';
import { specToMap } from '../procgen/specToMap.js';
import { generateTheme } from '../procgen/themes.js';
import { startSurvival, endSurvival, computeScore } from '../state/survivalState.js';
import { isInsideObjective } from '../modes/objectiveZone.js';
import { WaveDirector } from '../modes/survival/WaveDirector.js';
import { INITIAL_SURVIVAL_STATE, type SurvivalState } from '../state/survivalState.js';
import { INITIAL_TIME_TRIAL_STATE } from '../state/timeTrialState.js';

export { TARGET_SHARDS };

const ROUND_RESET_DELAY_MS = 8000;
const POWERUP_SPAWN_COUNT = 38;
const OBJECTIVE_TICK_MS = 100; // 10hz

/** Numeric seed for this round so shards and powerups get new positions every round. */
function roundSeedNumeric(baseSeed: number, roundId: number): number {
  return (baseSeed + roundId * 7919) >>> 0;
}

export class RoundController {
  private startMatchInProgress = false;
  private waveDirector: WaveDirector | null = null;
  private lastObjectiveTickMs = 0;
  private lastHeartbeatSec = 0;

  constructor(
    private readonly world: World,
    private readonly worldState: WorldState,
    private readonly shardSystem: ShardSystem,
    private readonly powerUpSystem: PowerUpSystem,
    private readonly objectiveSystem: ObjectiveSystem,
    private readonly spawnSystem: SpawnSystem,
    private readonly hud: HudService,
    private readonly scoreService: ScoreService,
    private readonly botManager?: BotManager
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
    const config = this.worldState.matchConfig;
    const roundSeed = config.seed + (nextRoundId === 1 ? '' : `_r${nextRoundId}`);

    const { spec, usedSeed, attempt } = generateValidArena(roundSeed, {
      size: config.size,
      attempts: 16,
    });
    const theme = generateTheme(roundSeed);
    const map = specToMap(spec, theme);

    await this.world.loadMap(map);

    this.worldState.mapData = map;
    this.worldState.procgenSpec = spec;
    this.worldState.mapSpec = spec;
    this.worldState.usedSeed = usedSeed;
    this.worldState.procgenAttempt = attempt;
    this.worldState.spawn.spawnPoints = [];
    this.worldState.spawn.lastSpawnIndexByPlayerId = {};

    const walls = spec.wallSegments?.length ?? 0;
    const cover = spec.cover?.length ?? 0;
    console.log(
      '[procgen] mode=%s seed=%s usedSeed=%s attempt=%s walls=%s cover=%s',
      config.mode,
      config.seed,
      usedSeed,
      attempt,
      walls,
      cover
    );

    if (usedSeed.startsWith('fallback')) {
      console.warn('[RoundController] round used fallback spec', { roundSeed, usedSeed });
    }

    this.finishStartMatch(nextRoundId);
    this.startMatchInProgress = false;
  }

  private finishStartMatch(roundId: number): void {
    const now = Date.now();
    const r = this.worldState.roundState;
    const config = this.worldState.matchConfig;

    r.status = 'RUNNING';
    r.roundId = roundId;
    r.matchDurationMs =
      config.mode === 'survival'
        ? config.survival.winSeconds * 1000
        : config.mode === 'timetrial'
          ? 600000
          : r.matchDurationMs;
    r.matchEndsAtMs = now + r.matchDurationMs;
    r.resetEndsAtMs = undefined;
    r.winnerPlayerId = undefined;

    const players = this.getMatchPlayers();

    for (const p of players) {
      this.scoreService.ensurePlayer(p.id, p.name);
    }

    this.scoreService.resetForPlayers(players);
    this.worldState.resetAllPlayerShards();

    this.waveDirector = null;
    this.lastObjectiveTickMs = now;
    this.lastHeartbeatSec = 0;

    if (config.mode === 'survival') {
      startSurvival(this.worldState.survivalState, now);
      this.waveDirector = new WaveDirector(
        this.worldState.mapSpec,
        this.worldState.usedSeed,
        config.survival.interWaveDelayMs,
        () => this.onWaveCleared(),
        (wave) => this.onWaveStart(wave)
      );
      this.waveDirector.start(now);
    } else if (config.mode === 'timetrial') {
      this.worldState.timeTrialState = {
        ...INITIAL_TIME_TRIAL_STATE,
        status: 'RUNNING',
        startedAtMs: now,
        requiredCaptureMs: config.timetrial.requiredCaptureMs,
      };
    }

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

    this.botManager?.onRoundStarted();

    this.hud.broadcastRoundSplash();
    this.hud.broadcastHud();
  }

  private onWaveCleared(): void {
    const surv = this.worldState.survivalState;
    surv.wave = this.waveDirector?.currentWave ?? surv.wave;
    this.hud.broadcastToast('good', `Wave ${surv.wave} cleared`);
    this.hud.broadcastFeed(`Wave ${surv.wave} cleared`);
    this.hud.broadcastHud();
  }

  private onWaveStart(wave: number): void {
    this.worldState.survivalState.wave = wave;
    this.hud.broadcastToast('info', `Wave ${wave}`);
    this.hud.broadcastHud();
  }

  /**
   * Call at 10hz from index. Updates survival/timetrial objective time and wave director; checks end conditions.
   */
  tickObjectiveAndModes(nowMs: number): void {
    if (nowMs - this.lastObjectiveTickMs < OBJECTIVE_TICK_MS) return;
    const delta = nowMs - this.lastObjectiveTickMs;
    this.lastObjectiveTickMs = nowMs;

    const config = this.worldState.matchConfig;
    const r = this.worldState.roundState;
    if (r.status !== 'RUNNING') return;

    const firstPlayerPos = this.getFirstConnectedPlayerPosition();
    const insideObjective = firstPlayerPos
      ? isInsideObjective(this.worldState.mapSpec, firstPlayerPos)
      : false;

    if (config.mode === 'survival') {
      const surv = this.worldState.survivalState;
      if (surv.status !== 'RUNNING') return;
      surv.elapsedMs = nowMs - surv.startedAtMs;
      if (insideObjective) surv.inObjectiveMs += delta;
      surv.lastTickMs = nowMs;

      this.waveDirector?.update(nowMs);
      surv.wave = this.waveDirector?.currentWave ?? surv.wave;
      surv.enemiesRemaining = this.waveDirector?.liveEnemies ?? 0;

      const winByWaves = surv.wave >= config.survival.winWaves;
      const winByTime = surv.elapsedMs >= config.survival.winSeconds * 1000;
      if (winByWaves || winByTime) {
        this.endSurvivalMatch(true);
        return;
      }

      const sec = Math.floor(surv.elapsedMs / 1000);
      if (sec > this.lastHeartbeatSec) {
        this.lastHeartbeatSec = sec;
        this.hud.broadcastHud();
      }
    } else if (config.mode === 'timetrial') {
      const tt = this.worldState.timeTrialState;
      if (tt.status !== 'RUNNING') return;
      if (insideObjective) tt.captureMs += delta;

      if (tt.captureMs >= tt.requiredCaptureMs) {
        this.endTimeTrialMatch();
        return;
      }

      const sec = Math.floor((nowMs - tt.startedAtMs) / 1000);
      if (sec > this.lastHeartbeatSec) {
        this.lastHeartbeatSec = sec;
        this.hud.broadcastHud();
      }
    }
  }

  private getFirstConnectedPlayerPosition(): { x: number; y: number; z: number } | null {
    const connected = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    for (const player of connected) {
      const entities = this.world.entityManager.getPlayerEntitiesByPlayer(player);
      const entity = entities[0];
      if (entity?.isSpawned) {
        const p = entity.position;
        return { x: p.x, y: p.y, z: p.z };
      }
    }
    return null;
  }

  /** Called when the solo player is KO'd in survival mode (lose). */
  onSurvivalPlayerDeath(): void {
    this.endSurvivalMatch(false);
  }

  private endSurvivalMatch(won: boolean): void {
    const now = Date.now();
    const surv = this.worldState.survivalState;
    endSurvival(surv, now);
    this.waveDirector = null;

    const score = computeScore(surv);
    this.hud.broadcastToast(won ? 'good' : 'bad', won ? `You win! Score: ${score}` : `You died. Score: ${score}`);
    this.hud.broadcastFeed(won ? `Survival win! Score: ${score}` : `Survival ended. Score: ${score}`);
    this.hud.broadcastHud();

    this.worldState.roundState.status = 'ENDED';
    this.worldState.roundState.resetEndsAtMs = now + ROUND_RESET_DELAY_MS;
  }

  private endTimeTrialMatch(): void {
    const now = Date.now();
    const tt = this.worldState.timeTrialState;
    tt.status = 'ENDED';
    const totalTimeMs = now - tt.startedAtMs;
    const score = Math.max(0, 300000 - totalTimeMs);
    this.hud.broadcastToast('good', `Time Trial complete! Score: ${score}`);
    this.hud.broadcastFeed(`Time Trial complete in ${(totalTimeMs / 1000).toFixed(1)}s. Score: ${score}`);
    this.hud.broadcastHud();

    this.worldState.roundState.status = 'ENDED';
    this.worldState.roundState.resetEndsAtMs = now + ROUND_RESET_DELAY_MS;
  }

  /** Call when an enemy entity dies (e.g. from NPC system). Increments survivalState.kills and wave director. */
  onEnemyDeath(): void {
    this.worldState.survivalState.kills += 1;
    this.waveDirector?.onEnemyDeath();
  }

  /**
   * Restart flow: validate status === 'ENDED', generate new seed, regenerate arena, reset mode state, start match.
   * Call from /restart or when UI sends restart_request.
   */
  handleRestartRequest(): boolean {
    const surv = this.worldState.survivalState;
    const tt = this.worldState.timeTrialState;
    if (surv.status !== 'ENDED' && tt.status !== 'ENDED') return false;

    this.worldState.matchConfig.seed =
      this.worldState.usedSeed + ':next:' + Date.now();
    const fresh: SurvivalState = { ...INITIAL_SURVIVAL_STATE };
    this.worldState.survivalState = fresh;
    this.worldState.timeTrialState = { ...INITIAL_TIME_TRIAL_STATE };

    this.worldState.roundState.status = 'STARTING';
    this.beginStartMatch();
    return true;
  }

  /** Called by tick when RESETTING delay has elapsed; kicks off async map load then match start. */
  startMatch(): void {
    this.beginStartMatch();
  }

  /** Current safe radius for Time Trial boundary (deterministic). Shrinks every 5s. */
  getTimeTrialSafeRadius(nowMs: number): number {
    const spec = this.worldState.mapSpec;
    const tt = this.worldState.timeTrialState;
    if (!spec || tt.status !== 'RUNNING') return Infinity;
    const outer = spec.ringRadii[0] ?? 120;
    const shrinkPer5s = 15;
    const elapsed5s = Math.floor((nowMs - tt.startedAtMs) / 5000);
    return Math.max(0, outer - elapsed5s * shrinkPer5s);
  }

  /** Distance from arena center (x,z). */
  getPlayerDistanceFromCenter(pos: { x: number; z: number }): number {
    return Math.sqrt(pos.x * pos.x + pos.z * pos.z);
  }

  /** Whether Time Trial boundary should apply damage at this time (throttled in caller). */
  isOutsideTimeTrialSafeRadius(nowMs: number, playerPos: { x: number; z: number }): boolean {
    const safe = this.getTimeTrialSafeRadius(nowMs);
    const dist = this.getPlayerDistanceFromCenter(playerPos);
    return dist > safe;
  }

  /* -------------------------------------------------------------------------- */
  /* MATCH END (TIMER OR OBJECTIVE)                                             */
  /* -------------------------------------------------------------------------- */

  endMatch(winnerPlayerId?: string, winnerDisplayName?: string): void {
    const r = this.worldState.roundState;
    if (r.status !== 'RUNNING') return;

    const now = Date.now();
    const winnerIsBot = winnerPlayerId != null && this.worldState.botDisplayNames.has(winnerPlayerId);
    this.botManager?.onRoundEnded(winnerPlayerId, winnerIsBot);

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
      const winnerName =
        winnerDisplayName ??
        this.worldState.botDisplayNames.get(winnerId) ??
        this.getPlayerDisplayName(winnerId);
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
    const mode = this.worldState.matchConfig.mode;

    if (
      r.status === 'RUNNING' &&
      r.matchEndsAtMs &&
      now >= r.matchEndsAtMs &&
      mode !== 'survival' &&
      mode !== 'timetrial'
    ) {
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
