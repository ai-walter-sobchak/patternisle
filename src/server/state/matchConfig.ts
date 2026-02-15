import type { MatchConfig } from '../modes/types.js';

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  mode: 'survival',
  size: 250,
  seed: `match_${Date.now()}`,
  survival: {
    winWaves: 10,
    winSeconds: 300,
    interWaveDelayMs: 4000,
  },
  timetrial: {
    requiredCaptureMs: 30_000,
  },
};
