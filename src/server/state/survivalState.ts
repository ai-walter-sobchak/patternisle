/**
 * Solo Survival mode state. Updated at 10hz; no per-tick spam.
 */

export interface SurvivalState {
  status: 'IDLE' | 'RUNNING' | 'ENDED';
  startedAtMs: number;
  elapsedMs: number;
  wave: number;
  kills: number;
  score: number;
  inObjectiveMs: number;
  lastTickMs: number;
  /** Enemies still alive this wave (mirrored from WaveDirector). */
  enemiesRemaining: number;
}

export const INITIAL_SURVIVAL_STATE: SurvivalState = {
  status: 'IDLE',
  startedAtMs: 0,
  elapsedMs: 0,
  wave: 0,
  kills: 0,
  score: 0,
  inObjectiveMs: 0,
  lastTickMs: 0,
  enemiesRemaining: 0,
};

export function startSurvival(state: SurvivalState, nowMs: number): void {
  state.status = 'RUNNING';
  state.startedAtMs = nowMs;
  state.elapsedMs = 0;
  state.wave = 0;
  state.kills = 0;
  state.score = 0;
  state.inObjectiveMs = 0;
  state.lastTickMs = nowMs;
}

export function endSurvival(state: SurvivalState, nowMs: number): void {
  state.status = 'ENDED';
  state.elapsedMs = nowMs - state.startedAtMs;
  state.score = computeScore(state);
  state.lastTickMs = nowMs;
}

/**
 * Score formula (deterministic, no Math.random):
 * base = floor(elapsedMs / 1000)
 * + wave * 25
 * + kills * 10
 * + floor(inObjectiveMs / 1000) * 2
 */
export function computeScore(state: SurvivalState): number {
  const base = Math.floor(state.elapsedMs / 1000);
  const waveBonus = state.wave * 25;
  const killBonus = state.kills * 10;
  const objectiveBonus = Math.floor(state.inObjectiveMs / 1000) * 2;
  return base + waveBonus + killBonus + objectiveBonus;
}
