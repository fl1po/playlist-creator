import { abortableSleep } from './abort.js';
import type { SpotifyClient } from './types.js';

/**
 * Centralized request pacer — enforces a minimum interval between any two
 * Spotify API calls so we never exceed the rolling rate-limit window.
 *
 * All concurrent callers are serialized through an internal mutex: each one
 * awaits its turn, sleeps until the minimum interval has elapsed since the
 * previous request, then proceeds.
 */
export class RequestPacer {
  private baseIntervalMs: number;
  private currentIntervalMs: number;
  private lastRequestTime = 0;
  private consecutiveSuccesses = 0;
  private mutex: Promise<void> = Promise.resolve();

  /** Max backoff interval (30 seconds). */
  private static readonly MAX_INTERVAL_MS = 30_000;

  /** After this many consecutive successes, halve the penalty. */
  private static readonly RECOVERY_THRESHOLD = 20;

  constructor(requestsPerSecond = 1) {
    this.baseIntervalMs = Math.round(1000 / requestsPerSecond);
    this.currentIntervalMs = this.baseIntervalMs;
  }

  /**
   * Wait until enough time has passed since the last request.
   * Serialized: concurrent callers queue up.
   * Sleep is abortable via client.api getter (throws on abort).
   */
  async pace(client: SpotifyClient): Promise<void> {
    // Chain onto the mutex so callers serialize
    const prev = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((r) => {
      release = r;
    });

    await prev;

    try {
      const elapsed = Date.now() - this.lastRequestTime;
      const wait = this.currentIntervalMs - elapsed;
      if (wait > 0) {
        await abortableSleep(wait, client);
      }
      this.lastRequestTime = Date.now();
    } finally {
      release();
    }
  }

  /** Called when a 429 is received despite pacing — doubles the interval. */
  onRateLimit(): void {
    this.consecutiveSuccesses = 0;
    this.currentIntervalMs = Math.min(
      this.currentIntervalMs * 2,
      RequestPacer.MAX_INTERVAL_MS,
    );
  }

  /** Called on every successful request — gradually recovers to base rate. */
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

  /** Human-readable current rate for logging. */
  get currentRate(): string {
    const rps = 1000 / this.currentIntervalMs;
    if (rps >= 1) return `${rps.toFixed(1)} req/s`;
    return `1 req/${(this.currentIntervalMs / 1000).toFixed(1)}s`;
  }

  /** Current interval in milliseconds (for event callbacks). */
  get intervalMs(): number {
    return this.currentIntervalMs;
  }
}
