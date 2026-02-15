/**
 * HYTOPIA SDK Boilerplate
 *
 * This is a simple boilerplate to get started on your project.
 * It implements the bare minimum to be able to run and connect
 * to your game server and run around as the basic player entity.
 *
 * From here you can begin to implement your own game logic
 * or do whatever you want!
 *
 * You can find documentation here: https://github.com/hytopiagg/sdk/blob/main/docs/server.md
 *
 * For more in-depth examples, check out the examples folder in the SDK, or you
 * can find it directly on GitHub: https://github.com/hytopiagg/sdk/tree/main/examples/payload-game
 *
 * You can officially report bugs or request features here: https://github.com/hytopiagg/sdk/issues
 *
 * To get help, have found a bug, or want to chat with
 * other HYTOPIA devs, join our Discord server:
 * https://discord.gg/DXCXJbHSJX
 *
 * Official SDK Github repo: https://github.com/hytopiagg/sdk
 * Official SDK NPM Package: https://www.npmjs.com/package/hytopia
 */

import {
  startServer,
  Audio,
  DefaultPlayerEntity,
  DefaultPlayerEntityController,
  PlayerEvent,
  PlayerManager,
  PlayerUIEvent,
  WorldLoopEvent,
} from 'hytopia';

import worldMap from './assets/map.json';
import { WorldState } from './src/server/state/WorldState.js';
import { generateValidArena } from './src/server/procgen/generateValidArena.js';
import { specHash } from './src/server/procgen/stableSpec.js';

function logMapBounds(map: any) {
  // Support array of blocks or object keyed by "x,y,z"
  const raw = map?.blocks;
  const blocks: { x: number; y: number; z: number }[] = [];
  if (Array.isArray(raw)) {
    for (const b of raw) {
      const x = typeof b.x === 'number' ? b.x : b.position?.x;
      const y = typeof b.y === 'number' ? b.y : b.position?.y;
      const z = typeof b.z === 'number' ? b.z : b.position?.z;
      if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') {
        blocks.push({ x, y, z });
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const key of Object.keys(raw)) {
      const parts = key.split(',').map(Number);
      if (parts.length === 3 && parts.every(n => !Number.isNaN(n))) {
        blocks.push({ x: parts[0], y: parts[1], z: parts[2] });
      }
    }
  }

  if (!blocks.length) {
    console.warn('[map] bounds: no blocks found');
    return;
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const { x, y, z } of blocks) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  console.log('[map] bounds', { minX, maxX, minY, maxY, minZ, maxZ, count: blocks.length });
}

logMapBounds(worldMap);

import { HudService } from './src/server/services/HudService.js';
import { ScoreService } from './src/server/services/ScoreService.js';
import { CombatService } from './src/server/services/CombatService.js';
import { ShardSystem } from './src/server/systems/ShardSystem.js';
import { ObjectiveSystem } from './src/server/systems/ObjectiveSystem.js';
import { SpawnSystem } from './src/server/systems/SpawnSystem.js';
import { PowerUpSystem } from './src/server/systems/PowerUpSystem.js';
import { RoundController, TARGET_SHARDS } from './src/server/systems/RoundController.js';
import { RoundManager } from './src/server/systems/RoundManager.js';
import { BotManager } from './src/server/systems/BotManager.js';
import { TowerSystem } from './src/server/systems/TowerSystem.js';
import { DepositSystem } from './src/server/systems/DepositSystem.js';
import { DEFAULT_MATCH_CONFIG } from './src/server/state/matchConfig.js';
import { MELEE_DAMAGE, SPAWN_PROTECTION_MS } from './src/server/config/combat.js';

startServer(async world => {
  // WorldState: single source of truth for this match (one per server run).
  const matchId = `match-${world.id}-${Date.now()}`;
  const worldState = new WorldState(matchId);
  worldState.mapData = worldMap;
  worldState.matchConfig = { ...DEFAULT_MATCH_CONFIG, seed: matchId };
  console.log(
    '[Patternisle] matchId=%s seed=%d mode=%s configSeed=%s size=%d',
    worldState.matchId,
    worldState.seed,
    worldState.matchConfig.mode,
    worldState.matchConfig.seed,
    worldState.matchConfig.size
  );

  const DEV_MODE = false; // Set true to allow /setmatch while players are connected.
  /** Enable dev cheat commands (/teleport, /moreshards) without full DEV_MODE. Set PATTERNISLE_DEV_CHEATS=1 to test. */
  const DEV_CHEATS = DEV_MODE || process.env.PATTERNISLE_DEV_CHEATS === '1';
  /** Players who have run /devcheats in this session can use /teleport and /moreshards. */
  const devCheatsEnabledPlayerIds = new Set<string>();

  console.log('[map] json keys:', Object.keys(worldMap || {}));
  console.log('[map] json size:', JSON.stringify(worldMap || {}).length);

  try {
    console.log('[map] loading assets/map.json...');
    await world.loadMap(worldMap);
    console.log('[map] loadMap() complete');
  } catch (err) {
    console.error('[map] loadMap() FAILED', err);
  }

  const hud = new HudService(world, worldState);
  const scoreService = new ScoreService(worldState);

  const objectiveSystem = new ObjectiveSystem(world, worldState, hud, scoreService);
  const spawnSystem = new SpawnSystem(worldState);

  let roundController: RoundController;

  const shardSystem = new ShardSystem(world, worldState, {
    onShardsAwarded: (playerId) => roundController?.onPlayerShardsChanged(playerId),
    hud,
  });

  const powerUpSystem = new PowerUpSystem(world, worldState, spawnSystem, hud);

  const towerSystem = new TowerSystem(world, worldState, hud);
  const depositSystem = new DepositSystem(world, worldState, hud, towerSystem);
  depositSystem.setTowerSystem(towerSystem);

  const botManager = new BotManager(world, worldState, {
    shardSystem,
    spawnSystem,
    hud,
    onBotWin: (winnerBotId, winnerDisplayName) => {
      roundController.endMatch(winnerBotId, winnerDisplayName);
    },
  });

  roundController = new RoundController(
    world,
    worldState,
    shardSystem,
    powerUpSystem,
    objectiveSystem,
    spawnSystem,
    hud,
    scoreService,
    botManager,
    towerSystem,
    depositSystem
  );

  towerSystem.setOnWinCallback((winnerPlayerId) => {
    roundController.endMatch(winnerPlayerId);
  });

  const combatService = new CombatService(
    world,
    worldState,
    roundController,
    hud,
    scoreService,
    shardSystem,
    depositSystem,
    botManager
  );

  // =========================================================
  // Round lifecycle: RoundController is the sole authority (tickMatchLifecycle).
  // RoundManager exists for optional callbacks/logging but is NOT used for timing
  // (no startRound() call), avoiding conflicting 120s/10s vs 180s/8s timers.
  // =========================================================
  let roundManager: RoundManager;
  const services: { roundManager?: RoundManager } = {};

  // Safe wrappers so this file runs even if you haven't added the methods yet.
  // Strongly recommended: implement RoundController.onRoundStarted/onRoundEnded/onRoundReset.
  function rcOnRoundStarted() {
    const rc: any = roundController as any;
    if (typeof rc.onRoundStarted === 'function') return rc.onRoundStarted();
    if (typeof rc.startMatch === 'function') return rc.startMatch();
    if (typeof rc.forceStart === 'function') return rc.forceStart();
    console.warn('[Round] RoundController has no onRoundStarted/startMatch/forceStart');
  }

  function rcOnRoundEnded(winnerName?: string) {
    const rc: any = roundController as any;
    if (typeof rc.onRoundEnded === 'function') return rc.onRoundEnded(winnerName);
    if (typeof rc.endMatch === 'function') return rc.endMatch(winnerName);
    console.warn('[Round] RoundController has no onRoundEnded/endMatch (winner=%s)', winnerName ?? 'none');
  }

  function rcOnRoundReset() {
    const rc: any = roundController as any;
    if (typeof rc.onRoundReset === 'function') return rc.onRoundReset();
    if (typeof rc.resetMatch === 'function') return rc.resetMatch();
    console.warn('[Round] RoundController has no onRoundReset/resetMatch');
  }

  roundManager = new RoundManager({
    targetScore: TARGET_SHARDS,
    onTransition: (event) => {
      if (event.type === 'started') {
        console.log(`[Round] started id=${event.roundId} seed=${event.seed}`);
        rcOnRoundStarted();
      } else if (event.type === 'ended') {
        const winner = event.winnerName ?? 'none';
        console.log(`[Round] ended id=${event.roundId} winner=${winner}`);
        rcOnRoundEnded(event.winnerName);
      } else {
        console.log(`[Round] reset id=${event.roundId} nextStartsInMs=${event.nextStartsInMs}`);
        rcOnRoundReset();
      }
    },
  });

  services.roundManager = roundManager;

  // =========================================================
  // Shared handler for JOIN + RECONNECT (keeps logic in sync)
  // =========================================================
  function handlePlayerEnteredWorld(
    player: any,
    opts?: { resetShardsOnEnter?: boolean }
  ) {
    const resetShardsOnEnter = opts?.resetShardsOnEnter !== false;

    // Always ensure score entry so joiners (including late) appear on leaderboard
    scoreService.ensurePlayer(player.id, player.name ?? player.id);

    const status = worldState.roundState.status;

    // RUNNING or RESETTING: mid-match enter — init combat, (optional) reset shards, spawn, sync HUD
    if (status === 'RUNNING' || status === 'RESETTING') {
      const ps = worldState.getPlayer(player.id);
      if (ps) {
        ps.controlsLockedUntilMs = undefined;
        ps.isEliminatedUntilMs = undefined;
        ps.lastAttackAtMs = undefined;
        ps.invulnerableUntilMs = Date.now() + SPAWN_PROTECTION_MS;
      }
      combatService.resetHealth(player.id);

      if (resetShardsOnEnter) {
        worldState.resetPlayerShards(player.id);
      }

      roundController.respawnPlayer(player);
      hud.sendHud(player);
      hud.broadcastHud();
      return;
    }

    // Fallback: at least keep their HUD synced
    hud.sendHud(player);
  }

  // =========================================================
  // One authoritative tick: match lifecycle, power-ups, proximity pickups
  // =========================================================

  const BASE_RUN_VELOCITY = 8;
  const BASE_JUMP_VELOCITY = 10;
  const SPEED_BOOST_MULT = 1.5;
  const JUMP_BOOST_MULT = 1.4;

  function applyMovementEffects() {
    const players = PlayerManager.instance.getConnectedPlayersByWorld(world);
    for (const player of players) {
      const entities = world.entityManager.getPlayerEntitiesByPlayer(player);
      const entity = entities[0];
      if (!entity?.isSpawned || !entity.controller) continue;
      const ctrl = entity.controller;
      if (!(ctrl instanceof DefaultPlayerEntityController)) continue;
      const ps = worldState.getPlayer(player.id);
      const effects = ps?.effects ?? [];
      const hasSpeed = effects.some((e: { kind: string }) => e.kind === 'SPEED');
      const hasJump = effects.some((e: { kind: string }) => e.kind === 'JUMP');
      const movement = ctrl as { runVelocity: number; jumpVelocity: number };
      movement.runVelocity = hasSpeed
        ? BASE_RUN_VELOCITY * SPEED_BOOST_MULT
        : BASE_RUN_VELOCITY;
      movement.jumpVelocity = hasJump
        ? BASE_JUMP_VELOCITY * JUMP_BOOST_MULT
        : BASE_JUMP_VELOCITY;
    }
  }

  world.loop.on(WorldLoopEvent.TICK_START, ({ tickDeltaMs }) => {
    shardSystem.tick(tickDeltaMs);
    roundController.tickMatchLifecycle();
    powerUpSystem.tick();

    // Proximity pickup checks (PowerUpSystem throttles internally)
    const players = PlayerManager.instance.getConnectedPlayersByWorld(world);
    for (const p of players) {
      powerUpSystem.tryPickup(p);
    }

    applyMovementEffects();
  });

  const OBJECTIVE_RESPAWN_INTERVAL_MS = 250;
  const FALL_RECOVERY_COOLDOWN_MS = 2000;
  const VOID_Y = -20;
  const OBJECTIVE_TICK_MS = 100; // 10hz for survival/timetrial
  const BOUNDARY_DAMAGE_THROTTLE_MS = 1000;
  let lastBoundaryDamageMs = 0;

  setInterval(() => {
    const now = Date.now();
    roundController.tickObjectiveAndModes(now);
    roundController.tickTower(now);

    if (
      worldState.matchConfig.mode === 'timetrial' &&
      worldState.roundState.status === 'RUNNING' &&
      worldState.timeTrialState.status === 'RUNNING'
    ) {
      const connected = PlayerManager.instance.getConnectedPlayersByWorld(world);
      for (const player of connected) {
        const entities = world.entityManager.getPlayerEntitiesByPlayer(player);
        const entity = entities[0];
        if (!entity?.isSpawned) continue;
        const pos = entity.position;
        if (roundController.isOutsideTimeTrialSafeRadius(now, { x: pos.x, z: pos.z })) {
          if (now - lastBoundaryDamageMs >= BOUNDARY_DAMAGE_THROTTLE_MS) {
            lastBoundaryDamageMs = now;
            combatService.damage(player.id, 15, { kind: 'hazard' });
          }
        }
      }
    }
  }, OBJECTIVE_TICK_MS);

  setInterval(() => {
    objectiveSystem.tickRespawn();

    // Fall recovery: respawn players who fell off the island (y < -20), with per-player cooldown
    const now = Date.now();
    const connected = PlayerManager.instance.getConnectedPlayersByWorld(world);

    for (const player of connected) {
      const entities = world.entityManager.getPlayerEntitiesByPlayer(player);
      const entity = entities[0];
      if (!entity?.isSpawned || entity.position.y >= VOID_Y) continue;

      const ps = worldState.getPlayer(player.id);
      if (
        ps?.lastFallRecoveryAtMs != null &&
        now - ps.lastFallRecoveryAtMs < FALL_RECOVERY_COOLDOWN_MS
      ) continue;

      roundController.respawnPlayer(player);
      combatService.resetHealth(player.id);
      if (ps) ps.invulnerableUntilMs = Date.now() + SPAWN_PROTECTION_MS;

      hud.sendHud(player);
      hud.toast(player, 'info', 'Recovered');
      if (ps) ps.lastFallRecoveryAtMs = now;
    }
  }, OBJECTIVE_RESPAWN_INTERVAL_MS);

  /**
   * Handle player joining the game.
   */
  world.on(PlayerEvent.JOINED_WORLD, ({ player }) => {
    worldState.registerPlayer(player.id);

    // Lobby: do NOT auto-start. Wait for player to select mode and click Start (handled via UI DATA).

    const playerEntity = new DefaultPlayerEntity({
      player,
      name: 'Player',
    });

    const spawnPos = roundController.getSpawnPositionForNewPlayer(player.id);
    playerEntity.spawn(world, spawnPos);

    // Load our game UI for this player
    player.ui.load('ui/index.html');
    player.ui.sendData({ v: 1, type: 'ping', ts: Date.now() });

    // Attack action from UI (e.g. mobile interact button or click)
    player.ui.on(PlayerUIEvent.DATA, ({ data }: { data: Record<string, unknown> }) => {
      if (data?.type === 'attack') {
        combatService.tryMeleeAttack(player);
        return;
      }
      // Lobby: mode selection and start (only when round is in LOBBY)
      if (worldState.roundState.status === 'LOBBY') {
        if (data?.type === 'set_mode' && typeof data.mode === 'string') {
          const mode = data.mode as import('./src/server/modes/types.js').GameMode;
          const allowed: import('./src/server/modes/types.js').GameMode[] = ['MULTI', 'SOLO', 'survival', 'timetrial', 'tower'];
          if (allowed.includes(mode)) {
            worldState.matchConfig.mode = mode;
            hud.broadcastHud();
          }
          return;
        }
        if (data?.type === 'start_match') {
          roundController.forceStart();
          return;
        }
      }
    });

    // JOIN: reset shards for fairness on late-join
    handlePlayerEnteredWorld(player, { resetShardsOnEnter: true });

    hud.toast(player, 'info', 'Connected');
    hud.sendRoundSplashToPlayer(player);

    world.chatManager.sendPlayerMessage(player, 'Patternisle connected');

    world.chatManager.sendPlayerMessage(player, 'Welcome to the game!', '00FF00');
    world.chatManager.sendPlayerMessage(player, 'Use WASD to move around & space to jump.');
    world.chatManager.sendPlayerMessage(player, 'Hold shift to sprint.');
    world.chatManager.sendPlayerMessage(player, 'Random cosmetic items are enabled for testing!');
    world.chatManager.sendPlayerMessage(player, 'Press \\ to enter or exit debug view.');
  });

  /**
   * Handle player leaving the game.
   */
  world.on(PlayerEvent.LEFT_WORLD, ({ player }) => {
    worldState.disconnectPlayer(player.id);
    devCheatsEnabledPlayerIds.delete(player.id);
    world.entityManager.getPlayerEntitiesByPlayer(player).forEach(entity => entity.despawn());
  });

  /**
   * Handle player reconnecting (UI reload + resync).
   */
  world.on(PlayerEvent.RECONNECTED_WORLD, ({ player }) => {
    player.ui.load('ui/index.html');
    player.ui.sendData({ v: 1, type: 'ping', ts: Date.now() });

    // RECONNECT: do NOT reset shards
    handlePlayerEnteredWorld(player, { resetShardsOnEnter: false });
  });

  /**
   * A silly little easter egg command.
   */
  world.chatManager.registerCommand('/rocket', player => {
    world.entityManager.getPlayerEntitiesByPlayer(player).forEach(entity => {
      entity.applyImpulse({ x: 0, y: 20, z: 0 });
    });
  });

  // --- Debug commands (WorldState) ---
  const isDev = process.env.NODE_ENV !== 'production' || DEV_MODE;

  world.chatManager.registerCommand('/seed', (player, args) => {
    const arg = args[0]?.trim();
    if (!arg) {
      world.chatManager.sendPlayerMessage(player, `matchId=${worldState.matchId} seed=${worldState.seed}`);
      return;
    }
    // Dev-only: /seed <number> or /seed random — set match seed, generate spec, toast seed + hash
    if (!isDev) {
      world.chatManager.sendPlayerMessage(player, `matchId=${worldState.matchId} seed=${worldState.seed}`);
      return;
    }
    const seedStr = arg === 'random' ? `random_${Date.now()}_${Math.floor(Math.random() * 1e6)}` : `seed_${arg}`;
    const { spec, usedSeed } = generateValidArena(seedStr, 16);

    if (usedSeed.startsWith('fallback')) {
      console.error('[procgen] fallback used in live match', { seed: seedStr, usedSeed });
      if (isDev) {
        console.error('[procgen] hard fail in dev when fallback triggers');
        process.exit(1);
      }
      world.chatManager.sendPlayerMessage(player, `Fallback used for seed ${seedStr}; see server log.`);
      return;
    }

    worldState.setMatchId(seedStr);
    worldState.procgenSpec = spec;
    shardSystem.regeneratePickups(worldState.seed);

    const hash = specHash(spec).slice(0, 12);
    const msg = `seed=${seedStr} fallback=no hash=${hash}`;
    console.log('[procgen] /seed', msg);
    hud.broadcastToast('info', msg);
    world.chatManager.sendPlayerMessage(player, msg);
  });

  world.chatManager.registerCommand('/state', player => {
    const p = worldState.getPlayer(player.id);
    if (!p) {
      world.chatManager.sendPlayerMessage(player, 'Not registered.');
      return;
    }
    const total = worldState.players.size;
    const techniques = p.unlockedTechniques.length ? p.unlockedTechniques.join(',') : 'none';
    const stats = `c=${p.stats.creaturesCreated} i=${p.stats.islandsDiscovered} h=${p.stats.hybridsCreated}`;
    world.chatManager.sendPlayerMessage(
      player,
      `players=${total} shards=${p.shards} techniques=${techniques} connected=${p.connected} stats(${stats})`
    );
  });

  world.chatManager.registerCommand('/setmatch', (player, args) => {
    const newId = args[0]?.trim();
    if (!newId) {
      world.chatManager.sendPlayerMessage(player, 'Usage: /setmatch <string>');
      return;
    }
    const allowed = DEV_MODE || !worldState.hasConnectedPlayers();
    if (!allowed) {
      world.chatManager.sendPlayerMessage(player, 'Refused: players connected. Set DEV_MODE or disconnect all.');
      return;
    }
    worldState.setMatchId(newId);
    shardSystem.regeneratePickups(worldState.seed);
    console.log('[Patternisle] setmatch: matchId=%s seed=%d', worldState.matchId, worldState.seed);
    world.chatManager.sendPlayerMessage(player, `matchId=${worldState.matchId} seed=${worldState.seed}`);
  });

  world.chatManager.registerCommand('/shards', player => {
    const remaining = shardSystem.getRemainingCount();
    const p = worldState.getPlayer(player.id);
    const total = p?.shards ?? 0;
    world.chatManager.sendPlayerMessage(
      player,
      `Shards: ${total} (you). Remaining pickups: ${remaining}`
    );
  });

  world.chatManager.registerCommand('/claim', player => {
    const playerState = worldState.getPlayer(player.id);
    if (playerState?.controlsLockedUntilMs != null && Date.now() < playerState.controlsLockedUntilMs) {
      world.chatManager.sendPlayerMessage(player, 'Round resetting...');
      return;
    }
    if (worldState.roundState.status !== 'RUNNING') {
      world.chatManager.sendPlayerMessage(player, 'Round resetting...');
      return;
    }
    const claimed = objectiveSystem.tryClaim(player);
    if (claimed) {
      world.chatManager.sendPlayerMessage(player, 'Golden Apple claimed!', '00FF00');
    } else {
      world.chatManager.sendPlayerMessage(
        player,
        'Cannot claim: get within range of the Golden Apple and try again.'
      );
    }
  });

  world.chatManager.registerCommand('/restart', player => {
    const ok = roundController.handleRestartRequest();
    if (ok) {
      world.chatManager.sendPlayerMessage(player, 'Restarting match...');
    } else {
      world.chatManager.sendPlayerMessage(
        player,
        'Can only restart when survival or timetrial has ended (status=ENDED).'
      );
    }
  });

  world.chatManager.registerCommand('/killenemy', player => {
    if (worldState.matchConfig.mode !== 'survival') {
      world.chatManager.sendPlayerMessage(player, 'Only in survival mode.');
      return;
    }
    (roundController as { onEnemyDeath?: () => void }).onEnemyDeath?.();
    world.chatManager.sendPlayerMessage(player, 'Enemy killed (test).');
  });

  world.chatManager.registerCommand('/round', player => {
    const r = worldState.roundState;
    const winner = r.winnerPlayerId ?? 'none';
    world.chatManager.sendPlayerMessage(
      player,
      `roundId=${r.roundId} status=${r.status} target=${TARGET_SHARDS} winner=${winner}`
    );
  });

  world.chatManager.registerCommand('/forcestart', player => {
    if (!DEV_MODE) {
      world.chatManager.sendPlayerMessage(player, 'Refused: /forcestart is DEV_MODE only.');
      return;
    }
    roundController.forceStart();
    world.chatManager.sendPlayerMessage(player, 'Round force-started.');
  });

  world.chatManager.registerCommand('/start', (player) => {
    if (!DEV_MODE) {
      world.chatManager.sendPlayerMessage(player, 'Refused: /start is DEV_MODE only.');
      return;
    }
    roundController.forceStart();
    world.chatManager.sendPlayerMessage(player, 'Round started.');
  });

  world.chatManager.registerCommand('/spawnshards', player => {
    if (!DEV_MODE) {
      world.chatManager.sendPlayerMessage(player, 'Refused: /spawnshards is DEV_MODE only.');
      return;
    }
    shardSystem.regeneratePickups(worldState.seed);
    world.chatManager.sendPlayerMessage(player, `Regenerated ${shardSystem.pickups.size} shard pickups.`);
  });

  world.chatManager.registerCommand('/where', player => {
    if (!DEV_MODE) {
      world.chatManager.sendPlayerMessage(player, 'Refused: /where is DEV_MODE only.');
      return;
    }
    const entities = world.entityManager.getPlayerEntitiesByPlayer(player);
    const entity = entities[0];
    if (!entity?.isSpawned) {
      world.chatManager.sendPlayerMessage(player, 'Not spawned.');
      return;
    }
    const p = entity.position;
    world.chatManager.sendPlayerMessage(
      player,
      `Position: x=${p.x.toFixed(2)} y=${p.y.toFixed(2)} z=${p.z.toFixed(2)}`
    );
  });

  /** Turn on dev cheats for yourself so you can use /teleport and /moreshards (no server restart needed). */
  world.chatManager.registerCommand('/devcheats', player => {
    devCheatsEnabledPlayerIds.add(player.id);
    world.chatManager.sendPlayerMessage(player, 'Dev cheats enabled. You can use /teleport, /moreshards, and /tier.', '00FF00');
  });

  const canUseDevCheats = (playerId: string) => DEV_CHEATS || devCheatsEnabledPlayerIds.has(playerId);

  /** Dev: teleport to arena center (shard drop zone). */
  world.chatManager.registerCommand('/teleport', player => {
    if (!canUseDevCheats(player.id)) {
      world.chatManager.sendPlayerMessage(player, 'Refused: use /devcheats first to enable cheat commands.');
      return;
    }
    const entities = world.entityManager.getPlayerEntitiesByPlayer(player);
    const entity = entities[0];
    if (!entity?.isSpawned) {
      world.chatManager.sendPlayerMessage(player, 'Not spawned.');
      return;
    }
    const center = depositSystem.getConsolePosition();
    const origin = { x: center.x, y: 50, z: center.z };
    const direction = { x: 0, y: -1, z: 0 };
    const hit = world.simulation.raycast(origin, direction, 200);
    const y = hit ? hit.hitPoint.y + 2 : center.y + 2;
    const pos = { x: center.x, y, z: center.z };
    entity.setPosition(pos);
    world.chatManager.sendPlayerMessage(player, `Teleported to arena center (shard drop zone).`, '00FF00');
  });

  /** Dev: add shards so you have enough for the next tier (or TARGET_SHARDS in non-tower). */
  world.chatManager.registerCommand('/moreshards', player => {
    if (!canUseDevCheats(player.id)) {
      world.chatManager.sendPlayerMessage(player, 'Refused: use /devcheats first to enable cheat commands.');
      return;
    }
    const p = worldState.getPlayer(player.id);
    if (!p) {
      world.chatManager.sendPlayerMessage(player, 'Not registered.');
      return;
    }
    const mode = worldState.matchConfig.mode;
    const tierThresholds = [8, 18, 30];
    let need = 0;
    if (mode === 'tower' && worldState.towerState) {
      const ts = worldState.towerState;
      const next = tierThresholds[ts.unlockedTier];
      if (next != null) {
        const current = (p.bankedShards ?? 0) + (p.carriedShards ?? 0);
        need = Math.max(0, next - current);
        if (need > 0) p.carriedShards = (p.carriedShards ?? 0) + need;
      }
    }
    if (need <= 0) {
      const current = p.shards ?? 0;
      need = Math.max(0, TARGET_SHARDS - current);
      if (need > 0) p.shards = current + need;
    }
    if (need > 0) {
      hud.sendHud(player);
      roundController?.onPlayerShardsChanged?.(player.id);
      world.chatManager.sendPlayerMessage(player, `+${need} shards (next tier / target).`, '00FF00');
    } else {
      world.chatManager.sendPlayerMessage(player, 'You already have enough shards for the next tier.');
    }
  });

  /** Dev: build the next tier of the tower (tower mode only). */
  world.chatManager.registerCommand('/tier', player => {
    if (!canUseDevCheats(player.id)) {
      world.chatManager.sendPlayerMessage(player, 'Refused: use /devcheats first to enable cheat commands.');
      return;
    }
    const built = towerSystem.unlockAndBuildNextTier();
    if (built) {
      world.chatManager.sendPlayerMessage(player, 'Next tower tier built.', '00FF00');
    } else {
      const mode = worldState.matchConfig.mode;
      const ts = worldState.towerState;
      if (mode !== 'tower' || !ts) {
        world.chatManager.sendPlayerMessage(player, 'Tower mode only. Current mode: ' + (mode ?? 'unknown') + '.');
      } else {
        world.chatManager.sendPlayerMessage(player, 'Tower is already at max tier (3).');
      }
    }
  });

  const MELEE_RANGE = 3.0;

  world.chatManager.registerCommand('/hit', (player, args) => {
    const targetQuery = args[0]?.trim();
    if (!targetQuery) {
      world.chatManager.sendPlayerMessage(player, 'Usage: /hit <targetNameOrId>');
      return;
    }
    if (!combatService.canAttack(player.id)) {
      world.chatManager.sendPlayerMessage(player, 'Melee on cooldown or round not running.');
      return;
    }
    const attackerId = player.id;
    const attackerEntities = world.entityManager.getPlayerEntitiesByPlayer(player);
    const attackerEntity = attackerEntities[0];
    if (!attackerEntity?.isSpawned) {
      world.chatManager.sendPlayerMessage(player, 'Not spawned.');
      return;
    }
    const attackerPos = attackerEntity.position;
    const connectedPlayers = PlayerManager.instance.getConnectedPlayersByWorld(world);
    const connected = connectedPlayers.map((p) => {
      const entities = world.entityManager.getPlayerEntitiesByPlayer(p);
      return {
        id: p.id,
        name: (p as { name?: string }).name,
        entity: entities[0],
      };
    });
    const q = targetQuery.toLowerCase();
    const candidates = connected.filter(
      (c: { id: string; name?: string }) =>
        c.id !== attackerId &&
        (c.id.toLowerCase().includes(q) || (c.name != null && String(c.name).toLowerCase().includes(q)))
    );
    if (candidates.length === 0) {
      world.chatManager.sendPlayerMessage(player, 'No matching player.');
      return;
    }
    let closest: { id: string; dist: number; entity?: unknown } | null = null;
    for (const c of candidates) {
      const entity = c.entity as { position?: { x: number; y: number; z: number } } | undefined;
      const pos = entity?.position;
      if (!pos) continue;
      const dx = pos.x - attackerPos.x;
      const dy = pos.y - attackerPos.y;
      const dz = pos.z - attackerPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist <= MELEE_RANGE && (closest == null || dist < closest.dist)) {
        closest = { id: c.id, dist, entity: c.entity };
      }
    }
    if (closest == null) {
      world.chatManager.sendPlayerMessage(
        player,
        `No player within ${MELEE_RANGE}m. Use /where to check position.`
      );
      return;
    }
    combatService.damage(closest.id, MELEE_DAMAGE, { kind: 'melee', attackerId });
    combatService.applyKnockback(closest.id, attackerId);
    const ps = worldState.getPlayer(attackerId);
    if (ps) ps.lastAttackAtMs = Date.now();
    world.chatManager.sendPlayerMessage(player, 'Hit!', '00FF00');
  });

  /**
   * Play some peaceful ambient music to set the mood!
   */
  new Audio({
    uri: 'audio/music/hytopia-main-theme.mp3',
    loop: true,
    volume: 0.1,
  }).play(world);
});
