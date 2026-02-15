/**
 * BotManager: server-authoritative NPC competitors.
 * Spawns bots at round start, runs shared 250ms AI loop, collects shards, can win round.
 * Cleans up intervals on round end/reset; no per-tick spam.
 *
 * How to test:
 * 1. Start the server and join the world (round starts on first join).
 * 2. Bots spawn only in shard-race mode (not survival/timetrial). Set matchConfig.mode to 'MULTI' or 'SOLO' to test (default is 'survival').
 * 3. Check feed for "Bots joined the arena: Rogue-1, Shadow-2, ...".
 * 4. Collect shards; bots collect via server-side proximity (tryCollectForBot). Leaderboard (HUD) shows bots.
 * 5. Let a bot reach TARGET_SHARDS (25) to see bot win: toast "Rogue-1 claimed the round.", round ends, winner name in HUD.
 * 6. Set BOT_DEBUG_LOGS=true for spawn/despawn and tier logs.
 * 7. After 3 human wins in a row, next round should increase bot count; after 2 losses, decrease (check logs).
 */

import {
  Entity,
  World,
  PlayerManager,
  Collider,
  ColliderShape,
  RigidBodyType,
  EntityModelAnimationLoopMode,
} from 'hytopia';
import { SPAWN_PROTECTION_MS } from '../config/combat.js';
import type { WorldState } from '../state/WorldState.js';
import type { ShardSystem } from './ShardSystem.js';
import type { SpawnSystem } from './SpawnSystem.js';
import type { HudService } from '../services/HudService.js';
import { ARENA_BOUNDS } from '../config/arenaBounds.js';
import { TARGET_SHARDS } from '../constants.js';
import type { BotState, DifficultyTier, BotDifficultyScalingState } from './bots/types.js';
import {
  BOT_DEBUG_LOGS,
  BOT_AI_INTERVAL_MS,
  BOT_MAX_COUNT,
  BOT_DEFAULT_COUNT,
  BOT_RECENT_ROUNDS_CAP,
  BOT_FAIRNESS_BOT_WIN_RATE_CEILING,
  BOT_DOMINANCE_PCT_THRESHOLD,
  BOT_WIN_STREAK_TO_BUMP,
  BOT_LOSS_STREAK_TO_EASE,
} from './bots/types.js';
import { plan, createBotState } from './bots/BotBrain.js';
import type { SpawnPoint } from '../state/types.js';

const BOT_NAMES = [
  'Rogue', 'Shadow', 'Blitz', 'Vex', 'Nova', 'Echo', 'Cipher', 'Rift',
];
const AGGRESSION_RADIUS = 8;
const BOT_MOVE_STEP = 1.0; // per 250ms tick — fast enough to reach shards (~4 u/s)

export type OnBotWinCallback = (winnerBotId: string, winnerDisplayName: string) => void;

export interface BotManagerOptions {
  shardSystem: ShardSystem;
  spawnSystem: SpawnSystem;
  hud: HudService;
  onBotWin: OnBotWinCallback;
}

/** When true, use goblin-shaman.gltf for bot visuals; when false, use a block so NPCs are always visible. */
const BOT_USE_MODEL = true;
/** GLTF model for bot NPCs (used when BOT_USE_MODEL is true). */
const BOT_MODEL_URI = 'models/goblin-shaman.gltf';
const BOT_MODEL_SCALE = 1;
/** Goblin model animation names (from goblin-shaman.gltf). */
const BOT_ANIM_IDLE = 'animation.goblin_shaman.idle';
const BOT_ANIM_WALK = 'animation.goblin_shaman.walk';
/** Block fallback when BOT_USE_MODEL is false (guarantees visible NPCs). */
const BOT_BLOCK_HALF_EXTENTS = { x: 0.4, y: 0.6, z: 0.4 };
const BOT_BLOCK_TEXTURE = 'blocks/emerald-ore.png';

export class BotManager {
  private readonly bots: BotState[] = [];
  private readonly botEntities: Map<string, Entity> = new Map();
  private aiIntervalId: ReturnType<typeof setInterval> | null = null;
  private scalingState: BotDifficultyScalingState = {
    winStreakByPlayerId: new Map(),
    lossStreakByPlayerId: new Map(),
    avgRoundTimeSecByPlayerId: new Map(),
    recentBotWins: [],
    recentRoundsCap: BOT_RECENT_ROUNDS_CAP,
  };

  constructor(
    private readonly world: World,
    private readonly worldState: WorldState,
    private readonly options: BotManagerOptions
  ) {}

  /** Called when round becomes RUNNING: spawn bots, start AI loop. Only in shard-race modes. */
  onRoundStarted(): void {
    this.stopAiLoop();
    const mode = this.worldState.matchConfig.mode;
    if (mode === 'survival' || mode === 'timetrial') {
      return;
    }
    const count = this.computeBotCount();
    const tierMix = this.computeTierMix(count);
    const positions = this.getSpawnPositionsForBots(count);

    for (let i = 0; i < count; i++) {
      const botId = `bot-${this.worldState.roundState.roundId}-${i}`;
      const displayName = `${BOT_NAMES[i % BOT_NAMES.length]}-${i + 1}`;
      const tier = tierMix[i] ?? 'MEDIUM';
      const rawPos = positions[i] ?? { x: 0, y: 5, z: 0 };
      const pos = this.resolveGroundPosition(rawPos);
      const bot = createBotState(botId, displayName, tier, pos, Date.now());
      this.bots.push(bot);
      this.worldState.ensurePlayerState(botId, false);
      this.worldState.botDisplayNames.set(botId, displayName);
      this.spawnBotEntity(botId, displayName, pos);
    }

    this.startAiLoop();

    if (count > 0) {
      if (BOT_DEBUG_LOGS) {
        const names = this.bots.map(b => b.displayName).join(', ');
        console.log(`[BotManager] spawned ${count} bots: ${names}`);
      }
      this.options.hud.broadcastFeed(`Bots joined the arena: ${this.bots.map(b => b.displayName).join(', ')}`);
    }
  }

  /** Called when round ends (ENDED/RESETTING): despawn bots, stop loop, update scaling. */
  onRoundEnded(winnerPlayerId?: string, winnerIsBot?: boolean): void {
    this.stopAiLoop();
    this.despawnAllBotEntities();
    this.updateScalingState(winnerPlayerId, winnerIsBot);

    for (const bot of this.bots) {
      this.worldState.botDisplayNames.delete(bot.botId);
    }
    this.bots.length = 0;

    if (BOT_DEBUG_LOGS) {
      console.log('[BotManager] despawned all bots');
    }
  }

  private computeBotCount(): number {
    const connected = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    if (connected.length === 0) return 0;

    let count = BOT_DEFAULT_COUNT;
    const recent = this.scalingState.recentBotWins;
    const botWinRate = recent.length > 0
      ? recent.filter(Boolean).length / recent.length
      : 0;

    if (botWinRate > BOT_FAIRNESS_BOT_WIN_RATE_CEILING) {
      count = Math.max(1, count - 1);
      if (BOT_DEBUG_LOGS) console.log('[BotManager] fairness: reduced bot count to', count);
    }

    for (const p of connected) {
      const winStreak = this.scalingState.winStreakByPlayerId.get(p.id) ?? 0;
      const lossStreak = this.scalingState.lossStreakByPlayerId.get(p.id) ?? 0;
      if (winStreak >= BOT_WIN_STREAK_TO_BUMP) {
        count = Math.min(BOT_MAX_COUNT, count + 1);
        if (BOT_DEBUG_LOGS) console.log('[BotManager] player win streak: increased bot count to', count);
        break;
      }
      if (lossStreak >= BOT_LOSS_STREAK_TO_EASE) {
        count = Math.max(1, count - 1);
        if (BOT_DEBUG_LOGS) console.log('[BotManager] player loss streak: reduced bot count to', count);
        break;
      }
    }
    return Math.min(BOT_MAX_COUNT, Math.max(0, count));
  }

  private computeTierMix(count: number): DifficultyTier[] {
    const tiers: DifficultyTier[] = ['EASY', 'MEDIUM', 'HARD', 'NIGHTMARE'];
    const mix: DifficultyTier[] = [];
    const connected = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    let bumpTier = false;
    for (const p of connected) {
      const winStreak = this.scalingState.winStreakByPlayerId.get(p.id) ?? 0;
      if (winStreak >= BOT_WIN_STREAK_TO_BUMP) {
        bumpTier = true;
        break;
      }
    }
    const half = Math.max(1, Math.floor(count / 2));
    for (let i = 0; i < count; i++) {
      if (bumpTier && i < half) {
        const idx = Math.min(3, tiers.indexOf('MEDIUM') + 1 + (i % 2));
        mix.push(tiers[idx] ?? 'HARD');
      } else {
        mix.push(i === 0 ? 'MEDIUM' : (['EASY', 'MEDIUM', 'HARD'] as DifficultyTier[])[i % 3] ?? 'MEDIUM');
      }
    }
    return mix;
  }

  private updateScalingState(winnerPlayerId?: string, winnerIsBot?: boolean): void {
    const connected = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    if (winnerIsBot) {
      this.scalingState.recentBotWins.push(true);
      for (const p of connected) {
        const loss = (this.scalingState.lossStreakByPlayerId.get(p.id) ?? 0) + 1;
        this.scalingState.lossStreakByPlayerId.set(p.id, loss);
        this.scalingState.winStreakByPlayerId.set(p.id, 0);
      }
    } else if (winnerPlayerId) {
      this.scalingState.recentBotWins.push(false);
      const win = (this.scalingState.winStreakByPlayerId.get(winnerPlayerId) ?? 0) + 1;
      this.scalingState.winStreakByPlayerId.set(winnerPlayerId, win);
      this.scalingState.lossStreakByPlayerId.set(winnerPlayerId, 0);
      for (const p of connected) {
        if (p.id !== winnerPlayerId) {
          const loss = (this.scalingState.lossStreakByPlayerId.get(p.id) ?? 0) + 1;
          this.scalingState.lossStreakByPlayerId.set(p.id, loss);
          this.scalingState.winStreakByPlayerId.set(p.id, 0);
        }
      }
    }
    while (this.scalingState.recentBotWins.length > this.scalingState.recentRoundsCap) {
      this.scalingState.recentBotWins.shift();
    }
  }

  /** Resolve ground Y so bots start at shard height and can pick up. */
  private resolveGroundPosition(pos: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const origin = { x: pos.x, y: 50, z: pos.z };
    const direction = { x: 0, y: -1, z: 0 };
    const hit = this.world.simulation.raycast(origin, direction, 200);
    const y = hit ? hit.hitPoint.y + 1 : pos.y;
    return { x: pos.x, y, z: pos.z };
  }

  private spawnBotEntity(botId: string, displayName: string, position: { x: number; y: number; z: number }): void {
    let entity: Entity;
    if (BOT_USE_MODEL) {
      const collider = Collider.optionsFromModelUri(BOT_MODEL_URI, BOT_MODEL_SCALE);
      entity = new Entity({
        name: `Bot-${displayName}`,
        isEnvironmental: false,
        modelUri: BOT_MODEL_URI,
        modelScale: BOT_MODEL_SCALE,
        modelAnimations: [
          { name: BOT_ANIM_IDLE, loopMode: EntityModelAnimationLoopMode.LOOP, play: true },
          { name: BOT_ANIM_WALK, loopMode: EntityModelAnimationLoopMode.LOOP, play: false },
        ],
        rigidBodyOptions: {
          type: RigidBodyType.KINEMATIC_POSITION,
          colliders: [collider],
        },
      });
    } else {
      entity = new Entity({
        name: `Bot-${displayName}`,
        isEnvironmental: false,
        blockTextureUri: BOT_BLOCK_TEXTURE,
        blockHalfExtents: BOT_BLOCK_HALF_EXTENTS,
        rigidBodyOptions: {
          type: RigidBodyType.KINEMATIC_POSITION,
          colliders: [
            { shape: ColliderShape.BLOCK, halfExtents: BOT_BLOCK_HALF_EXTENTS },
          ],
        },
      });
    }
    entity.spawn(this.world, position);
    this.botEntities.set(botId, entity);
  }

  private despawnAllBotEntities(): void {
    for (const entity of this.botEntities.values()) {
      if (entity.isSpawned) entity.despawn();
    }
    this.botEntities.clear();
  }

  /**
   * Spawn bots across the full arena so they don't cluster in the center.
   * Uses a deterministic grid over ARENA_BOUNDS (ignores player perimeter ring).
   */
  private getSpawnPositionsForBots(count: number): SpawnPoint[] {
    const { minX, maxX, minZ, maxZ, y } = ARENA_BOUNDS;
    const margin = 4;
    const rangeX = maxX - minX - 2 * margin;
    const rangeZ = maxZ - minZ - 2 * margin;
    if (rangeX <= 0 || rangeZ <= 0) {
      return Array.from({ length: count }, () => ({ x: (minX + maxX) / 2, y, z: (minZ + maxZ) / 2 }));
    }
    const cols = Math.max(1, Math.ceil(Math.sqrt(count * (rangeX / rangeZ))));
    const rows = Math.max(1, Math.ceil(count / cols));
    const stepX = cols > 1 ? rangeX / (cols - 1) : 0;
    const stepZ = rows > 1 ? rangeZ / (rows - 1) : 0;
    const points: SpawnPoint[] = [];
    for (let i = 0; i < count; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols) % rows;
      points.push({
        x: minX + margin + col * stepX,
        y,
        z: minZ + margin + row * stepZ,
      });
    }
    return points;
  }

  private getHumanAndBotPositions(): Array<{ playerId: string; position: { x: number; y: number; z: number } }> {
    const out: Array<{ playerId: string; position: { x: number; y: number; z: number } }> = [];
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    for (const player of players) {
      const entities = this.world.entityManager.getPlayerEntitiesByPlayer(player);
      const entity = entities[0];
      if (entity?.isSpawned) {
        const p = entity.position;
        out.push({ playerId: player.id, position: { x: p.x, y: p.y, z: p.z } });
      }
    }
    for (const bot of this.bots) {
      out.push({ playerId: bot.botId, position: { ...bot.position } });
    }
    return out;
  }

  private buildSnapshot(nowMs: number): import('./bots/types.js').BotWorldSnapshot {
    const shardPositions: Array<{ id: string; x: number; y: number; z: number }> = [];
    for (const [id, state] of this.options.shardSystem.pickups) {
      if (state.collected) continue;
      const pos = state.entity?.isSpawned ? state.entity.position : state.pos;
      shardPositions.push({ id, x: pos.x, y: pos.y, z: pos.z });
    }

    const playerPositions: Array<{ playerId: string; x: number; y: number; z: number }> = [];
    const players = PlayerManager.instance.getConnectedPlayersByWorld(this.world);
    for (const player of players) {
      const entities = this.world.entityManager.getPlayerEntitiesByPlayer(player);
      const entity = entities[0];
      if (entity?.isSpawned) {
        const p = entity.position;
        playerPositions.push({ playerId: player.id, x: p.x, y: p.y, z: p.z });
      }
    }

    const shardsByEntityId = new Map<string, number>();
    for (const [id, p] of this.worldState.players) {
      shardsByEntityId.set(id, p.shards);
    }

    return {
      nowMs,
      shardPositions,
      playerPositions,
      shardsByEntityId,
      targetShards: TARGET_SHARDS,
      bounds: {
        minX: ARENA_BOUNDS.minX,
        maxX: ARENA_BOUNDS.maxX,
        minZ: ARENA_BOUNDS.minZ,
        maxZ: ARENA_BOUNDS.maxZ,
      },
      aggressionRadius: AGGRESSION_RADIUS,
    };
  }

  private startAiLoop(): void {
    if (this.aiIntervalId != null) return;
    this.aiIntervalId = setInterval(() => this.tickBots(), BOT_AI_INTERVAL_MS);
  }

  private stopAiLoop(): void {
    if (this.aiIntervalId != null) {
      clearInterval(this.aiIntervalId);
      this.aiIntervalId = null;
    }
  }

  private tickBots(): void {
    if (this.worldState.roundState.status !== 'RUNNING') return;
    if (this.bots.length === 0) return;

    const now = Date.now();
    const snapshot = this.buildSnapshot(now);

    for (const bot of this.bots) {
      if (bot.state === 'CELEBRATE') continue;

      const action = plan(bot, snapshot);
      const shouldReplan = now - bot.lastPlanAtMs >= bot.targetReplanEveryMs;
      if (shouldReplan) {
        bot.state = action.state;
        bot.currentTarget = action.target;
        bot.lastPlanAtMs = now;
      }
      if (action.wobbleOffset) {
        bot.position.x += action.wobbleOffset.x;
        bot.position.y += action.wobbleOffset.y;
        bot.position.z += action.wobbleOffset.z;
      }

      const moveDir = action.moveDir;
      const step = BOT_MOVE_STEP * bot.speedMul;
      bot.lastPosition = { ...bot.position };
      bot.position.x += moveDir.x * step;
      bot.position.y += moveDir.y * step;
      bot.position.z += moveDir.z * step;
      bot.position.x = Math.max(snapshot.bounds.minX, Math.min(snapshot.bounds.maxX, bot.position.x));
      bot.position.z = Math.max(snapshot.bounds.minZ, Math.min(snapshot.bounds.maxZ, bot.position.z));

      const collected = this.options.shardSystem.tryCollectForBot(bot.botId, bot.position);
      if (collected) {
        const p = this.worldState.getPlayer(bot.botId);
        if (p && p.shards >= TARGET_SHARDS) {
          bot.state = 'CELEBRATE';
          this.options.hud.broadcastToast('good', `${bot.displayName} claimed the round.`);
          this.options.hud.broadcastFeed(`${bot.displayName} claimed the round.`);
          this.options.onBotWin(bot.botId, bot.displayName);
          return;
        }
      }

      const botEntity = this.botEntities.get(bot.botId);
      if (botEntity?.isSpawned) {
        botEntity.setPosition(bot.position);
        if (BOT_USE_MODEL && botEntity.isModelEntity) {
          const isMoving =
            moveDir.x !== 0 || moveDir.y !== 0 || moveDir.z !== 0;
          const idleAnim = botEntity.getModelAnimation(BOT_ANIM_IDLE);
          const walkAnim = botEntity.getModelAnimation(BOT_ANIM_WALK);
          if (isMoving) {
            walkAnim?.play();
            idleAnim?.pause();
          } else {
            idleAnim?.play();
            walkAnim?.pause();
          }
        }
      }
    }
  }

  /** For RoundController: optional hook to run before endMatch when round ends (e.g. despawn bots). */
  onRoundEnding(): void {
    this.stopAiLoop();
    this.despawnAllBotEntities();
    for (const bot of this.bots) {
      this.worldState.botDisplayNames.delete(bot.botId);
    }
    this.bots.length = 0;
  }

  getBotCount(): number {
    return this.bots.length;
  }

  getBots(): ReadonlyArray<BotState> {
    return this.bots;
  }

  /** Get the in-world entity for a bot (for combat knockback / position). */
  getBotEntity(botId: string): Entity | undefined {
    return this.botEntities.get(botId);
  }

  /** Get current position of a bot (from BotState; use for hit detection and drop position). */
  getBotPosition(botId: string): { x: number; y: number; z: number } | undefined {
    const bot = this.bots.find(b => b.botId === botId);
    return bot ? { ...bot.position } : undefined;
  }

  /**
   * Respawn a bot after death: new spawn point, reset health, short invulnerability.
   * Call after RESPAWN_DELAY_MS from combat KO.
   */
  respawnBot(botId: string): void {
    const bot = this.bots.find(b => b.botId === botId);
    if (!bot) return;

    const positions = this.getHumanAndBotPositions();
    const pos = this.options.spawnSystem.getSpawnForPlayer(botId, positions);
    const resolved = this.resolveGroundPosition(pos);

    bot.position.x = resolved.x;
    bot.position.y = resolved.y;
    bot.position.z = resolved.z;

    const entity = this.botEntities.get(botId);
    if (entity?.isSpawned) {
      entity.setPosition(resolved);
    }

    const ps = this.worldState.getPlayer(botId);
    if (ps) {
      const max = ps.maxHealth ?? 100;
      ps.health = max;
      ps.invulnerableUntilMs = Date.now() + SPAWN_PROTECTION_MS;
      ps.lastKillerId = undefined;
    }

    if (BOT_DEBUG_LOGS) {
      console.log(`[BotManager] respawnBot ${botId} at ${resolved.x.toFixed(1)},${resolved.y.toFixed(1)},${resolved.z.toFixed(1)}`);
    }
  }
}
