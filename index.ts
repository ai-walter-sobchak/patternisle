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
  PlayerEvent,
  PlayerUIEvent,
  WorldLoopEvent,
} from 'hytopia';

import worldMap from './assets/map.json';
import { WorldState } from './src/server/state/WorldState.js';

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
import { ShardSystem } from './src/server/systems/ShardSystem.js';
import { ObjectiveSystem } from './src/server/systems/ObjectiveSystem.js';
import { SpawnSystem } from './src/server/systems/SpawnSystem.js';
import {
  RoundController,
  TARGET_SHARDS,
} from './src/server/systems/RoundController.js';

/**
 * startServer is always the entry point for our game.
 * It accepts a single function where we should do any
 * setup necessary for our game. The init function is
 * passed a World instance which is the default
 * world created by the game server on startup.
 * 
 * Documentation: https://github.com/hytopiagg/sdk/blob/main/docs/server.startserver.md
 */

startServer(async world => {
  // WorldState: single source of truth for this match (one per server run).
  const matchId = `match-${world.id}-${Date.now()}`;
  const worldState = new WorldState(matchId);
  worldState.mapData = worldMap;
  console.log('[Patternisle] matchId=%s seed=%d', worldState.matchId, worldState.seed);

  const DEV_MODE = false; // Set true to allow /setmatch while players are connected.

  /**
   * Enable debug rendering of the physics simulation.
   * This will overlay lines in-game representing colliders,
   * rigid bodies, and raycasts. This is useful for debugging
   * physics-related issues in a development environment.
   * Enabling this can cause performance issues, which will
   * be noticed as dropped frame rates and higher RTT times.
   * It is intended for development environments only and
   * debugging physics.
   */
  
  // world.simulation.enableDebugRendering(true);

  /**
   * Load our map.
   * You can build your own map using https://build.hytopia.com
   * After building, hit export and drop the .json file in
   * the assets folder as map.json.
   */
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
  const objectiveSystem = new ObjectiveSystem(
    world,
    worldState,
    hud,
    scoreService
  );
  const spawnSystem = new SpawnSystem(worldState);
  let roundController: RoundController;
  const shardSystem = new ShardSystem(world, worldState, {
    onShardsAwarded: (playerId) =>
      roundController?.onPlayerShardsChanged(playerId),
    hud,
  });
  roundController = new RoundController(
    world,
    worldState,
    shardSystem,
    objectiveSystem,
    spawnSystem,
    hud,
    scoreService
  );
  shardSystem.generateAndSpawnPickups(worldState.seed);
  // Match starts on first player join when status is LOBBY (see JOINED_WORLD).

  world.loop.on(WorldLoopEvent.TICK_START, ({ tickDeltaMs }) => {
    shardSystem.tick(tickDeltaMs);
    // Match lifecycle no longer runs per-frame; see 250ms setInterval below.
  });

  const OBJECTIVE_RESPAWN_INTERVAL_MS = 250;
  setInterval(() => {
    objectiveSystem.tickRespawn();
    roundController.tickMatchLifecycle();
  }, OBJECTIVE_RESPAWN_INTERVAL_MS);

  /**
   * Handle player joining the game. The PlayerEvent.JOINED_WORLD
   * event is emitted to the world when a new player connects to
   * the game. From here, we create a basic player
   * entity instance which automatically handles mapping
   * their inputs to control their in-game entity and
   * internally uses our player entity controller.
   * 
   * The HYTOPIA SDK is heavily driven by events, you
   * can find documentation on how the event system works,
   * here: https://dev.hytopia.com/sdk-guides/events
   */
  world.on(PlayerEvent.JOINED_WORLD, ({ player }) => {
    worldState.registerPlayer(player.id);

    const playerEntity = new DefaultPlayerEntity({
      player,
      name: 'Player',
    });

    const spawnPos = roundController.getSpawnPositionForNewPlayer(player.id);
    playerEntity.spawn(world, spawnPos);

    // Load our game UI for this player
    player.ui.load('ui/index.html');
    player.ui.sendData({ v: 1, type: 'ping', ts: Date.now() });

    const playerName =
      player && 'name' in player && typeof (player as { name?: string }).name === 'string'
        ? (player as { name: string }).name
        : player.id;
    scoreService.ensurePlayer(player.id, playerName);
    if (worldState.roundState.status === 'LOBBY') {
      roundController.startMatch();
    } else {
      hud.sendHud(player);
    }

    hud.toast(player, 'info', 'Connected');
    hud.sendRoundSplashToPlayer(player);

    world.chatManager.sendPlayerMessage(player, 'Patternisle connected');

    // Send a nice welcome message that only the player who joined will see ;)
    world.chatManager.sendPlayerMessage(player, 'Welcome to the game!', '00FF00');
    world.chatManager.sendPlayerMessage(player, 'Use WASD to move around & space to jump.');
    world.chatManager.sendPlayerMessage(player, 'Hold shift to sprint.');
    world.chatManager.sendPlayerMessage(player, 'Random cosmetic items are enabled for testing!');
    world.chatManager.sendPlayerMessage(player, 'Press \\ to enter or exit debug view.');
  });

  /**
   * Handle player leaving the game. The PlayerEvent.LEFT_WORLD
   * event is emitted to the world when a player leaves the game.
   * Because HYTOPIA is not opinionated on join and
   * leave game logic, we are responsible for cleaning
   * up the player and any entities associated with them
   * after they leave. We can easily do this by 
   * getting all the known PlayerEntity instances for
   * the player who left by using our world's EntityManager
   * instance.
   * 
   * The HYTOPIA SDK is heavily driven by events, you
   * can find documentation on how the event system works,
   * here: https://dev.hytopia.com/sdk-guides/events
   */
  world.on(PlayerEvent.LEFT_WORLD, ({ player }) => {
    worldState.disconnectPlayer(player.id);
    world.entityManager.getPlayerEntitiesByPlayer(player).forEach(entity => entity.despawn());
  });

  /**
   * If a player's connection drops, or they quickly leave and reconnect to the same game,
   * it's considered a reconnect event and not a new join event, so we need to handle
   * that appropriately. In this case, we just need to reload the player's UI. If we had
   * UI data to sync too, we'd want to resync that as well here. RECONNECTED_WORLD is a special
   * event where the player is still in the world (the disconnect timer hasn't happened yet),
   * so the server hasn't closed their connection and therefore did not trigger LEFT_WORLD.
   */
  world.on(PlayerEvent.RECONNECTED_WORLD, ({ player }) => {
    // Reload the player's UI to ensure it's up to date.
    player.ui.load('ui/index.html');
    player.ui.sendData({ v: 1, type: 'ping', ts: Date.now() });
    hud.sendHud(player);
  });

  /**
   * A silly little easter egg command. When a player types
   * "/rocket" in the game, they'll get launched into the air!
   */
  world.chatManager.registerCommand('/rocket', player => {
    world.entityManager.getPlayerEntitiesByPlayer(player).forEach(entity => {
      entity.applyImpulse({ x: 0, y: 20, z: 0 });
    });
  });

  // --- Debug commands (WorldState) ---
  world.chatManager.registerCommand('/seed', player => {
    world.chatManager.sendPlayerMessage(player, `matchId=${worldState.matchId} seed=${worldState.seed}`);
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
      world.chatManager.sendPlayerMessage(
        player,
        'Refused: /forcestart is DEV_MODE only.'
      );
      return;
    }
    roundController.forceStart();
    world.chatManager.sendPlayerMessage(player, 'Round force-started.');
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

  /**
   * Play some peaceful ambient music to
   * set the mood!
   */
  
  new Audio({
    uri: 'audio/music/hytopia-main-theme.mp3',
    loop: true,
    volume: 0.1,
  }).play(world);
});
