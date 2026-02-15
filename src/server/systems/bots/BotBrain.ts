/**
 * BotBrain: pure decision logic for one bot.
 * Given bot state + world snapshot, returns desired action (move, state, target).
 * No side effects; human-like imperfections (hesitation, mistake rate, wobble).
 */

import type {
  BotState,
  BotWorldSnapshot,
  BotAction,
  DifficultyTier,
} from './types.js';
import { BOT_DEBUG_LOGS } from './types.js';

function sqDist(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function dist(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  return Math.sqrt(sqDist(a, b));
}

function normalize(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len < 1e-6) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/** Simple deterministic-ish rng for same-tick consistency (seed from botId). */
function botRng(botId: string, seed: number): number {
  let h = 0;
  for (let i = 0; i < botId.length; i++) h = (h * 31 + botId.charCodeAt(i)) | 0;
  h = (h + seed) >>> 0;
  h = (h * 1103515245 + 12345) >>> 0;
  return (h >>> 0) / 0xffffffff;
}

/**
 * Decide next action for one bot. Call at planning cadence (not every AI tick).
 */
export function plan(
  bot: BotState,
  snapshot: BotWorldSnapshot
): BotAction {
  const now = snapshot.nowMs;
  const pos = bot.position;

  // If we're in reaction lag or hesitation, return idle/minimal move
  if (now < bot.nextActAtMs || now < bot.hesitateUntilMs) {
    return {
      moveDir: { x: 0, y: 0, z: 0 },
      state: bot.state,
      target: bot.currentTarget,
    };
  }

  const rng = (s: number) => botRng(bot.botId, Math.floor(now / 1000) + s);
  const mistake = rng(1) < bot.mistakeRate;

  // ---- Target selection ----
  const nearestShard = getNearestShard(pos, snapshot.shardPositions);
  const nearestPlayer = getNearestPlayer(pos, snapshot.playerPositions);
  const aggressionRadius = snapshot.aggressionRadius;
  const nearPlayer = nearestPlayer
    ? dist(pos, { x: nearestPlayer.x, y: nearestPlayer.y, z: nearestPlayer.z }) <= aggressionRadius
    : false;

  let state: BotState['state'] = bot.state;
  let target: BotAction['target'] = bot.currentTarget;

  // Spread: sometimes pick a different shard so bots don't all pile on the same one (explore arena)
  const pickSpreadShard = (): { x: number; y: number; z: number } | null => {
    if (snapshot.shardPositions.length === 0) return null;
    if (snapshot.shardPositions.length === 1) {
      const s = snapshot.shardPositions[0]!;
      return { x: s.x, y: s.y, z: s.z };
    }
    const idx = Math.floor(rng(10) * snapshot.shardPositions.length);
    const s = snapshot.shardPositions[idx]!;
    return { x: s.x, y: s.y, z: s.z };
  };

  // Mistake: sometimes pick wrong target (go toward a random shard or stand)
  if (mistake && nearestShard && snapshot.shardPositions.length > 1) {
    const wrong = pickSpreadShard();
    if (wrong) target = wrong;
    state = 'SEEK_OBJECTIVE';
  } else if (nearPlayer && nearestPlayer) {
    const botShards = snapshot.shardsByEntityId.get(bot.botId) ?? 0;
    const playerShards = snapshot.shardsByEntityId.get(nearestPlayer.playerId) ?? 0;
    const shouldEngage =
      bot.aggression > 0.5 && playerShards >= botShards && rng(3) < bot.aggression;
    const shouldEvade = bot.aggression < 0.5 || (bot.aggression < 0.7 && playerShards > botShards);
    if (shouldEngage) {
      state = 'ENGAGE_PLAYER';
      target = nearestPlayer.playerId;
    } else if (shouldEvade) {
      state = 'EVADE';
      target = nearestPlayer.playerId; // move away from this id
    } else {
      state = 'SEEK_OBJECTIVE';
      target = (rng(11) < 0.25 ? pickSpreadShard() : null) ?? (nearestShard ? { x: nearestShard.x, y: nearestShard.y, z: nearestShard.z } : null);
    }
  } else {
    state = 'SEEK_OBJECTIVE';
    target = (rng(12) < 0.25 ? pickSpreadShard() : null) ?? (nearestShard ? { x: nearestShard.x, y: nearestShard.y, z: nearestShard.z } : null);
  }

  // ---- Move direction ----
  let moveDir = { x: 0, y: 0, z: 0 };

  if (state === 'SEEK_OBJECTIVE' && target && typeof target === 'object' && 'x' in target) {
    moveDir = directionToward(pos, target as { x: number; y: number; z: number });
  } else if (state === 'ENGAGE_PLAYER' && typeof target === 'string' && nearestPlayer?.playerId === target) {
    moveDir = directionToward(pos, {
      x: nearestPlayer.x,
      y: nearestPlayer.y,
      z: nearestPlayer.z,
    });
    // NIGHTMARE: simple intercept using last two positions
    if (bot.difficultyTier === 'NIGHTMARE' && bot.lastPosition) {
      const pred = predictPosition(
        { x: nearestPlayer.x, y: nearestPlayer.y, z: nearestPlayer.z },
        bot.lastPosition,
        pos,
        0.3
      );
      moveDir = directionToward(pos, pred);
    }
  } else if (state === 'EVADE' && typeof target === 'string' && nearestPlayer?.playerId === target) {
    const away = directionToward(pos, {
      x: nearestPlayer.x,
      y: nearestPlayer.y,
      z: nearestPlayer.z,
    });
    moveDir = { x: -away.x, y: -away.y, z: -away.z };
  }

  moveDir = normalize(moveDir);

  // Path wobble (small perpendicular offset)
  let wobbleOffset: { x: number; y: number; z: number } | undefined;
  if ((moveDir.x !== 0 || moveDir.z !== 0) && rng(4) < 0.15) {
    const w = 0.08 * (rng(5) - 0.5);
    wobbleOffset = {
      x: -moveDir.z * w,
      y: 0,
      z: moveDir.x * w,
    };
  }

  if (BOT_DEBUG_LOGS && (state !== bot.state || target !== bot.currentTarget)) {
    console.log(
      `[BotBrain] ${bot.displayName} state=${bot.state}->${state} target=${JSON.stringify(target)}`
    );
  }

  return {
    moveDir,
    state,
    target,
    wobbleOffset,
  };
}

function getNearestShard(
  pos: { x: number; y: number; z: number },
  shards: BotWorldSnapshot['shardPositions']
): { id: string; x: number; y: number; z: number } | null {
  let best: { id: string; x: number; y: number; z: number } | null = null;
  let bestD2 = Infinity;
  for (const s of shards) {
    const d2 = sqDist(pos, { x: s.x, y: s.y, z: s.z });
    if (d2 < bestD2) {
      bestD2 = d2;
      best = s;
    }
  }
  return best;
}

function getNearestPlayer(
  pos: { x: number; y: number; z: number },
  players: BotWorldSnapshot['playerPositions']
): { playerId: string; x: number; y: number; z: number } | null {
  let best: { playerId: string; x: number; y: number; z: number } | null = null;
  let bestD2 = Infinity;
  for (const p of players) {
    const d2 = sqDist(pos, { x: p.x, y: p.y, z: p.z });
    if (d2 < bestD2) {
      bestD2 = d2;
      best = p;
    }
  }
  return best;
}

function directionToward(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number }
): { x: number; y: number; z: number } {
  return {
    x: to.x - from.x,
    y: to.y - from.y,
    z: to.z - from.z,
  };
}

/** Simple intercept: predict where target will be (linear extrapolation from last two positions). */
function predictPosition(
  targetPos: { x: number; y: number; z: number },
  targetLastPos: { x: number; y: number; z: number },
  chaserPos: { x: number; y: number; z: number },
  t: number
): { x: number; y: number; z: number } {
  const vx = targetPos.x - targetLastPos.x;
  const vy = targetPos.y - targetLastPos.y;
  const vz = targetPos.z - targetLastPos.z;
  return {
    x: targetPos.x + vx * t,
    y: targetPos.y + vy * t,
    z: targetPos.z + vz * t,
  };
}

/**
 * Create initial bot state for a difficulty tier (with tier-specific ranges + jitter).
 */
export function createBotState(
  botId: string,
  displayName: string,
  tier: DifficultyTier,
  spawnPos: { x: number; y: number; z: number },
  nowMs: number
): BotState {
  const jitter = (lo: number, hi: number, seed: number) => {
    const h = (botId.length * 7919 + seed) >>> 0;
    const t = (h / 0xffffffff) * (hi - lo) + lo;
    return t;
  };

  let reactionTimeMs: number;
  let aggression: number;
  let mistakeRate: number;
  let speedMul: number;
  let targetReplanEveryMs: number;

  switch (tier) {
    case 'EASY':
      reactionTimeMs = jitter(450, 650, 1);
      aggression = jitter(0.25, 0.4, 2);
      mistakeRate = jitter(0.12, 0.18, 3);
      speedMul = jitter(0.95, 1.0, 4);
      targetReplanEveryMs = 1200 + jitter(0, 400, 5);
      break;
    case 'MEDIUM':
      reactionTimeMs = jitter(300, 450, 1);
      aggression = jitter(0.4, 0.6, 2);
      mistakeRate = jitter(0.07, 0.12, 3);
      speedMul = jitter(1.0, 1.05, 4);
      targetReplanEveryMs = 1000 + jitter(0, 350, 5);
      break;
    case 'HARD':
      reactionTimeMs = jitter(180, 320, 1);
      aggression = jitter(0.6, 0.8, 2);
      mistakeRate = jitter(0.03, 0.07, 3);
      speedMul = jitter(1.05, 1.1, 4);
      targetReplanEveryMs = 900 + jitter(0, 300, 5);
      break;
    case 'NIGHTMARE':
      reactionTimeMs = jitter(120, 220, 1);
      aggression = jitter(0.8, 0.95, 2);
      mistakeRate = jitter(0.01, 0.03, 3);
      speedMul = jitter(1.1, 1.15, 4);
      targetReplanEveryMs = 800 + jitter(0, 250, 5);
      break;
    default:
      reactionTimeMs = 400;
      aggression = 0.5;
      mistakeRate = 0.1;
      speedMul = 1.0;
      targetReplanEveryMs = 1000;
  }

  const reactionDelay = Math.min(reactionTimeMs * (0.8 + Math.random() * 0.4), 400);
  return {
    botId,
    displayName,
    difficultyTier: tier,
    reactionTimeMs,
    aggression,
    mistakeRate,
    speedMul,
    targetReplanEveryMs,
    lastPlanAtMs: nowMs,
    state: 'SEEK_OBJECTIVE',
    currentTarget: null,
    position: { ...spawnPos },
    nextActAtMs: nowMs + reactionDelay,
    hesitateUntilMs: nowMs,
  };
}
