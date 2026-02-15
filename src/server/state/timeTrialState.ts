/**
 * Solo Time Trial mode state. Capture progress and boundary hazard are deterministic.
 */

export interface TimeTrialState {
  status: 'RUNNING' | 'ENDED';
  startedAtMs: number;
  captureMs: number;
  requiredCaptureMs: number;
  bestTimeMs?: number;
}

export const INITIAL_TIME_TRIAL_STATE: TimeTrialState = {
  status: 'RUNNING',
  startedAtMs: 0,
  captureMs: 0,
  requiredCaptureMs: 30_000,
};
