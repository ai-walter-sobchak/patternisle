/**
 * RoundManager: authoritative round state per world.
 * No per-tick logic; transitions driven by setTimeout.
 */

export type RoundStatus = 'LOBBY' | 'RUNNING' | 'ENDED' | 'RESETTING';

export interface RoundState {
  roundId: number;
  status: RoundStatus;
  startedAtMs?: number;
  endsAtMs?: number;
  resetEndsAtMs?: number;
  targetScore: number;
  seed: string;
  winnerName?: string;
}

const ROUND_DURATION_MS = 120_000;
const RESET_DELAY_MS = 10_000;

export type RoundTransitionEvent =
  | { type: 'started'; roundId: number; seed: string }
  | { type: 'ended'; roundId: number; winnerName?: string }
  | { type: 'reset'; roundId: number; nextStartsInMs: number };

export interface RoundManagerOptions {
  targetScore?: number;
  onTransition?: (event: RoundTransitionEvent) => void;
}

export class RoundManager {
  private state: RoundState;
  private readonly onTransition?: (event: RoundTransitionEvent) => void;
  private endRoundTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private resetRoundTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private startRoundTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(options: number | RoundManagerOptions = 0) {
    const opts = typeof options === 'number' ? { targetScore: options } : options;
    const targetScore = opts.targetScore ?? 0;
    this.onTransition = opts.onTransition;
    this.state = {
      roundId: 0,
      status: 'LOBBY',
      targetScore,
      seed: '',
    };
  }

  startRound(): void {
    this.clearTimeouts();

    const now = Date.now();
    this.state = {
      ...this.state,
      roundId: this.state.roundId + 1,
      status: 'RUNNING',
      startedAtMs: now,
      endsAtMs: now + ROUND_DURATION_MS,
      resetEndsAtMs: undefined,
      seed: now.toString(),
      winnerName: undefined,
    };

    this.onTransition?.({ type: 'started', roundId: this.state.roundId, seed: this.state.seed });

    this.endRoundTimeoutId = setTimeout(() => {
      this.endRoundTimeoutId = null;
      this.endRound();
    }, ROUND_DURATION_MS);
  }

  endRound(winnerName?: string): void {
    this.clearTimeouts();

    const now = Date.now();
    this.state = {
      ...this.state,
      status: 'ENDED',
      winnerName,
      resetEndsAtMs: now + RESET_DELAY_MS,
    };

    this.onTransition?.({ type: 'ended', roundId: this.state.roundId, winnerName: this.state.winnerName });

    this.resetRoundTimeoutId = setTimeout(() => {
      this.resetRoundTimeoutId = null;
      this.resetRound();
    }, RESET_DELAY_MS);
  }

  resetRound(): void {
    this.clearTimeouts();

    const now = Date.now();
    this.state = {
      ...this.state,
      status: 'RESETTING',
      startedAtMs: undefined,
      endsAtMs: undefined,
      resetEndsAtMs: now + RESET_DELAY_MS,
      seed: '',
      winnerName: undefined,
    };

    this.onTransition?.({ type: 'reset', roundId: this.state.roundId, nextStartsInMs: RESET_DELAY_MS });

    this.startRoundTimeoutId = setTimeout(() => {
      this.startRoundTimeoutId = null;
      this.startRound();
    }, RESET_DELAY_MS);
  }

  getState(): Readonly<RoundState> {
    return this.state;
  }

  private clearTimeouts(): void {
    if (this.endRoundTimeoutId !== null) {
      clearTimeout(this.endRoundTimeoutId);
      this.endRoundTimeoutId = null;
    }
    if (this.resetRoundTimeoutId !== null) {
      clearTimeout(this.resetRoundTimeoutId);
      this.resetRoundTimeoutId = null;
    }
    if (this.startRoundTimeoutId !== null) {
      clearTimeout(this.startRoundTimeoutId);
      this.startRoundTimeoutId = null;
    }
  }
}
