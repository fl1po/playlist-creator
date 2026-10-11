import { type Clock, systemClock } from './clock.js';

/**
 * Interactive calls answer a person waiting on an HTTP response; background
 * calls belong to a task. Both count toward the same interval.
 */
export type Lane = 'interactive' | 'background';

interface Waiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Enforces a minimum interval between any two Spotify calls, server-wide —
 * the app's rate limit is shared by every user (ADR-0003). Waiters are served
 * one per interval, interactive before background. A 429 doubles the interval;
 * a run of successes halves it back toward the base rate.
 *
 * Also remembers an app-level ban (persistent 429s), so interactive calls can
 * fail fast instead of waiting it out.
 */
export class RequestPacer {
  private readonly baseIntervalMs: number;
  private currentIntervalMs: number;
  private lastRequestTime = 0;
  private consecutiveSuccesses = 0;
  private readonly queues: Record<Lane, Waiter[]> = {
    interactive: [],
    background: [],
  };
  private pumping = false;
  private bannedUntilMs = 0;

  /** Ceiling for the 429 backoff. */
  private static readonly MAX_INTERVAL_MS = 30_000;

  /** After this many consecutive successes, halve the penalty. */
  private static readonly RECOVERY_THRESHOLD = 20;

  constructor(
    requestsPerSecond = 1,
    private readonly clock: Clock = systemClock,
  ) {
    this.baseIntervalMs = Math.round(1000 / requestsPerSecond);
    this.currentIntervalMs = this.baseIntervalMs;
  }

  /** Wait for this caller's turn. Rejects with `signal.reason` if it aborts first. */
  pace(lane: Lane, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const queue = this.queues[lane];
          const i = queue.indexOf(waiter);
          if (i >= 0) queue.splice(i, 1);
          reject(signal.reason);
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queues[lane].push(waiter);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queues.interactive.length + this.queues.background.length) {
        const wait =
          this.currentIntervalMs - (this.clock.now() - this.lastRequestTime);
        if (wait > 0) await this.clock.sleep(wait);
        // Pick after the wait: an interactive call that arrived meanwhile
        // goes first, and waiters that aborted have left their queue.
        const next =
          this.queues.interactive.shift() ?? this.queues.background.shift();
        if (!next) continue;
        if (next.onAbort) {
          next.signal?.removeEventListener('abort', next.onAbort);
        }
        this.lastRequestTime = this.clock.now();
        next.resolve();
      }
    } finally {
      this.pumping = false;
    }
  }

  /** A 429 arrived despite pacing — double the interval. */
  onRateLimit(): void {
    this.consecutiveSuccesses = 0;
    this.currentIntervalMs = Math.min(
      this.currentIntervalMs * 2,
      RequestPacer.MAX_INTERVAL_MS,
    );
  }

  /** A call succeeded — gradually recover toward the base rate. */
  onSuccess(): void {
    this.consecutiveSuccesses++;
    if (
      this.currentIntervalMs > this.baseIntervalMs &&
      this.consecutiveSuccesses >= RequestPacer.RECOVERY_THRESHOLD
    ) {
      this.consecutiveSuccesses = 0;
      this.currentIntervalMs = Math.max(
        Math.round(this.currentIntervalMs / 2),
        this.baseIntervalMs,
      );
    }
  }

  /** Record an app-level ban lasting until `untilMs`. */
  ban(untilMs: number): void {
    this.bannedUntilMs = Math.max(this.bannedUntilMs, untilMs);
  }

  /** The end of the current ban, or null when there isn't one. */
  bannedUntil(): number | null {
    return this.bannedUntilMs > this.clock.now() ? this.bannedUntilMs : null;
  }

  /** Current interval in milliseconds. */
  get intervalMs(): number {
    return this.currentIntervalMs;
  }
}
