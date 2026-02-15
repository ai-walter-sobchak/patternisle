/**
 * Wave director for Solo Survival: deterministic wave count and spawn zone selection.
 * No Math.random; uses Rng(usedSeed + ':wave:' + waveNumber).
 * When NPCs exist, they should call onEnemyDeath() when an enemy entity dies.
 */

import type { MapSpecV1 } from '../../procgen/spec.js';
import { Rng } from '../../../shared/rng/Rng.js';

export type WaveClearedCallback = () => void;
export type WaveStartCallback = (wave: number) => void;

export class WaveDirector {
  private _currentWave = 0;
  private _liveEnemies = 0;
  private _nextWaveAtMs = 0;
  private onWaveCleared: WaveClearedCallback;
  private onWaveStart: WaveStartCallback;

  constructor(
    private readonly mapSpec: MapSpecV1 | null,
    private readonly usedSeed: string,
    private readonly interWaveDelayMs: number,
    onWaveCleared: WaveClearedCallback,
    onWaveStart: WaveStartCallback
  ) {
    this.onWaveCleared = onWaveCleared;
    this.onWaveStart = onWaveStart;
  }

  get currentWave(): number {
    return this._currentWave;
  }

  get liveEnemies(): number {
    return this._liveEnemies;
  }

  get nextWaveAtMs(): number {
    return this._nextWaveAtMs;
  }

  /** Start wave 1 at nowMs. */
  start(nowMs: number): void {
    this._currentWave = 1;
    this.spawnWave(nowMs);
    this.onWaveStart(1);
  }

  /** Call each tick or from interval; advances to next wave after inter-wave delay when liveEnemies === 0. */
  update(nowMs: number): void {
    if (this._liveEnemies > 0) return;
    if (nowMs < this._nextWaveAtMs) return;
    this._currentWave += 1;
    this.spawnWave(nowMs);
    this.onWaveStart(this._currentWave);
  }

  /** Call when an enemy entity dies. Decrements liveEnemies; when 0, schedules wave clear. */
  onEnemyDeath(): void {
    if (this._liveEnemies <= 0) return;
    this._liveEnemies -= 1;
    if (this._liveEnemies === 0) {
      this.onWaveCleared();
    }
  }

  /** Enemy count for wave n: wave 1 = 3, wave n = 3 + (n-1)*2. */
  private enemyCountForWave(wave: number): number {
    return 3 + (wave - 1) * 2;
  }

  /** Choose 2–3 spawn zones per wave using seeded Rng. Deterministic. */
  private spawnWave(nowMs: number): void {
    const count = this.enemyCountForWave(this._currentWave);
    this._liveEnemies = count;

    const seed = `${this.usedSeed}:wave:${this._currentWave}`;
    const rng = new Rng(seed);
    const numZones = rng.int(2, 3);
    if (this.mapSpec && this.mapSpec.spawnZones.length > 0) {
      const zones = this.mapSpec.spawnZones;
      const indices = new Set<number>();
      while (indices.size < Math.min(numZones, zones.length)) {
        indices.add(rng.int(0, zones.length - 1));
      }
      // Zones selected deterministically; actual entity spawn would use these zones.
    }

    this._nextWaveAtMs = nowMs + this.interWaveDelayMs;
  }

  /** Reset for new run (e.g. restart). */
  reset(): void {
    this._currentWave = 0;
    this._liveEnemies = 0;
    this._nextWaveAtMs = 0;
  }
}
