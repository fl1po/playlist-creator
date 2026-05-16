import { abortableSleep } from './abort.js';
import type { RequestPacer } from './request-pacer.js';
import {
  type ClassifiedError,
  type ErrorKind,
  classifyError,
} from './resilience/errors.js';
import type { ApiCallOptions, ApiResult, SpotifyClient } from './types.js';

export { classifyError };
export type { ClassifiedError, ErrorKind };

export function isAuthError(e: Error): boolean {
  return classifyError(e).kind === 'auth';
}

export interface RetryPolicy {
  server: { maxRetries: number; baseDelayMs: number };
  network: { maxRetries: number; baseDelayMs: number };
  rateLimit: {
    maxRetries: number;
    escalateAfter: number;
    longSleepMs: (count: number) => number;
  };
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  server: { maxRetries: 3, baseDelayMs: 5000 },
  network: { maxRetries: 10, baseDelayMs: 10000 },
  rateLimit: {
    maxRetries: 5,
    escalateAfter: 5,
    longSleepMs: (n) => (1 + n) * 60 * 60 * 1000,
  },
};

export interface ApiWrapperState {
  longSleepCount: number;
}

/**
 * Create an apiCall function bound to a SpotifyClient.
 * Handles retries, rate-limits, backoff, and auth errors.
 */
export function createApiCall(
  client: SpotifyClient,
  callbacks?: ApiCallOptions,
  pacer?: RequestPacer,
  retryPolicy?: Partial<RetryPolicy>,
) {
  const policy: RetryPolicy = {
    server: { ...DEFAULT_RETRY_POLICY.server, ...retryPolicy?.server },
    network: { ...DEFAULT_RETRY_POLICY.network, ...retryPolicy?.network },
    rateLimit: { ...DEFAULT_RETRY_POLICY.rateLimit, ...retryPolicy?.rateLimit },
  };
  const state: ApiWrapperState = { longSleepCount: 0 };

  async function apiCall<T>(
    fn: () => Promise<T>,
    description: string,
    retryCount = 0,
    authRetried = false,
  ): Promise<ApiResult<T>> {
    try {
      callbacks?.onBeforeCall?.();
      if (pacer) await pacer.pace(client);
      void client.api;
      const result = await fn();
      pacer?.onSuccess();
      if (state.longSleepCount > 0) {
        callbacks?.onSuccess?.();
        state.longSleepCount = 0;
      }
      return { success: true, data: result };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));

      // Abort errors → re-throw immediately, never swallow
      if (err.name === 'AbortError' || err.message === 'Stopped by user') {
        throw err;
      }

      const classified = classifyError(err);

      switch (classified.kind) {
        case 'auth': {
          if (!authRetried) {
            try {
              await client.recreateApi();
              return apiCall(fn, description, 0, true);
            } catch (refreshErr) {
              if (
                refreshErr instanceof Error &&
                (refreshErr.name === 'AbortError' ||
                  refreshErr.message === 'Stopped by user')
              ) {
                throw refreshErr;
              }
              return { success: false, authError: true, error: err };
            }
          }
          return { success: false, authError: true, error: err };
        }

        case 'server': {
          if (retryCount >= policy.server.maxRetries) {
            callbacks?.onError?.(description, err);
            return { success: false, error: err };
          }
          await abortableSleep(
            policy.server.baseDelayMs * (retryCount + 1),
            client,
          );
          return apiCall(fn, description, retryCount + 1);
        }

        case 'network': {
          if (retryCount >= policy.network.maxRetries) {
            callbacks?.onError?.(description, err);
            return { success: false, error: err };
          }
          callbacks?.onNetworkRetry?.(
            retryCount + 1,
            policy.network.maxRetries,
          );
          await abortableSleep(
            policy.network.baseDelayMs * (retryCount + 1),
            client,
          );
          return apiCall(fn, description, retryCount + 1);
        }

        case 'rate_limit': {
          pacer?.onRateLimit();
          if (retryCount >= policy.rateLimit.maxRetries) {
            state.longSleepCount++;
            const sleepMs = policy.rateLimit.longSleepMs(state.longSleepCount);
            const wakeTime = new Date(Date.now() + sleepMs);
            const sleepHours = sleepMs / (60 * 60 * 1000);
            callbacks?.onLongSleep?.(sleepHours, wakeTime);
            await abortableSleep(sleepMs, client);
            callbacks?.onLongSleepWake?.();
            await client.recreateApi();
            return apiCall(fn, description, 0);
          }
          const waitTime =
            classified.retryAfterSeconds != null
              ? classified.retryAfterSeconds + 1
              : 60 * (retryCount + 1);
          callbacks?.onRateLimitWait?.(waitTime);
          await abortableSleep(waitTime * 1000, client);
          return apiCall(fn, description, retryCount + 1);
        }

        default: {
          callbacks?.onError?.(description, err);
          return { success: false, error: err };
        }
      }
    }
  }

  return apiCall;
}
