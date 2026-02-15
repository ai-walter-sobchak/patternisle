/**
 * Bot system types: state, difficulty tiers, world snapshot, and config.
 * Server-authoritative; no per-tick spam.
 */

/** Difficulty tier for bot behavior and scaling. */
export type DifficultyTier = 'EASY' | 'MEDIUM' | 'HARD' | 'NIGHTMARE';

/** Internal bot behavior state. */
export type BotBehaviorState =
  | 'SEEK_OBJECTIVE'
  | 'ENGAGE_PLAYER'
  | 'EVADE'
  | 'IDLE'
  | 'CELEBRATE';

/** Single bot instance (server-side only). */
export interface BotState {
  botId: string;
  displayName: string;
  difficultyTier: DifficultyTier;
  /** Reaction delay in ms (with jitter applied). */
  reactionTimeMs: number;
  /** 0–1; higher = more likely to engage. */
  aggression: number;
  /** 0–1; chance to pick wrong target or hesitate. */
  mistakeRate: number;
  /** Movement speed multiplier (e.g. 0.95–1.15). */
  speedMul: number;
  /** Replan target every this many ms. */
  targetReplanEveryMs: number;
  /** Last time we ran planning for this bot (ms since epoch). */
  lastPlanAtMs: number;
  state: BotBehaviorState;
  /** Current target position or entity id (position preferred for shards). */
  currentTarget: { x: number; y: number; z: number } | string | null;
  /** Current position (server-side; no entity in world). */
  position: { x: number; y: number; z: number };
  /** Optional: last position for intercept prediction (NIGHTMARE). */
  lastPosition?: { x: number; y: number; z: number };
  /** When to next act (reaction lag); 0 = act now. */
  nextActAtMs: number;
  /** Small random pause for human-like hesitation. */
  hesitateUntilMs: number;
}

/** Snapshot passed to BotBrain each tick (read-only). */
export interface BotWorldSnapshot {
  nowMs: number;
  /** Remaining shard pickups (position only; id for reference). */
  shardPositions: Array<{ id: string; x: number; y: number; z: number }>;
  /** Human player positions (for engage/evade). */
  playerPositions: Array<{ playerId: string; x: number; y: number; z: number }>;
  /** Total shards per entity (playerId or botId). */
  shardsByEntityId: Map<string, number>;
  /** Target shards to win. */
  targetShards: number;
  /** Arena bounds for clamping. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Aggression radius: within this distance we consider engage/evade. */
  aggressionRadius: number;
}

/** Output from BotBrain: what the bot should do this tick. */
export interface BotAction {
  /** Normalized move direction (or zero to stand). */
  moveDir: { x: number; y: number; z: number };
  state: BotBehaviorState;
  target: { x: number; y: number; z: number } | string | null;
  /** Optional path wobble offset to add to position. */
  wobbleOffset?: { x: number; y: number; z: number };
}

/** Config constants (env or defaults). */
export const BOT_DEBUG_LOGS = process.env.BOT_DEBUG_LOGS === 'true';
export const BOT_AI_INTERVAL_MS = parseInt(
  process.env.BOT_AI_INTERVAL_MS ?? '250',
  10
);
export const BOT_MAX_COUNT = Math.min(
  8,
  Math.max(1, parseInt(process.env.BOT_MAX_COUNT ?? '8', 10))
);
export const BOT_DEFAULT_COUNT = Math.min(
  BOT_MAX_COUNT,
  Math.max(1, parseInt(process.env.BOT_DEFAULT_COUNT ?? '3', 10))
);

/** Per-human difficulty scaling state (for dynamic bot count/tier). */
export interface BotDifficultyScalingState {
  /** Consecutive wins per player id. */
  winStreakByPlayerId: Map<string, number>;
  /** Consecutive losses per player id. */
  lossStreakByPlayerId: Map<string, number>;
  /** Rolling average round duration (sec) per player. */
  avgRoundTimeSecByPlayerId: Map<string, number>;
  /** Last N round outcomes: true = human/bot win, false = other. Used for fairness ceiling. */
  recentBotWins: boolean[];
  readonly recentRoundsCap: number;
}

export const BOT_RECENT_ROUNDS_CAP = 10;
export const BOT_FAIRNESS_BOT_WIN_RATE_CEILING = 0.6;
export const BOT_DOMINANCE_PCT_THRESHOLD = 0.65;
export const BOT_WIN_STREAK_TO_BUMP = 3;
export const BOT_LOSS_STREAK_TO_EASE = 2;
