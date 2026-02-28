import { SpotifyApi } from "@spotify/web-api-ts-sdk";
import type { ApiCallOptions, ApiResult, SpotifyClient } from "./types.js";

function isRateLimitError(e: Error): boolean {
  const msg = e.message?.toLowerCase() ?? "";
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests")
  );
}

function isAuthError(e: Error): boolean {
  const msg = e.message?.toLowerCase() ?? "";
  return (
    msg.includes("401") ||
    msg.includes("invalid_request") ||
    msg.includes("invalid_grant") ||
    msg.includes("refresh token") ||
    msg.includes("unauthorized") ||
    msg.includes("bad request")
  );
}

function isNetworkError(e: Error): boolean {
  const msg = e.message?.toLowerCase() ?? "";
  return (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("etimedout") ||
    msg.includes("socket")
  );
}

export { isAuthError, isRateLimitError, isNetworkError };

export interface ApiWrapperState {
  longSleepCount: number;
}

/**
 * Create an apiCall function bound to a SpotifyClient.
 * The returned function handles retries, rate-limits, backoff, and auth errors
 * identically to the original apiCall() pattern.
 */
export function createApiCall(
  client: SpotifyClient,
  callbacks?: ApiCallOptions,
) {
  const state: ApiWrapperState = { longSleepCount: 0 };

  async function apiCall<T>(
    fn: () => Promise<T>,
    description: string,
    retryCount = 0,
  ): Promise<ApiResult<T>> {
    try {
      callbacks?.onBeforeCall?.();
      // Access client.api to trigger any abort checks on the client
      void client.api;
      const result = await fn();
      if (state.longSleepCount > 0) {
        callbacks?.onSuccess?.();
        state.longSleepCount = 0;
      }
      return { success: true, data: result };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));

      // Abort errors → re-throw immediately, never swallow
      if (err.name === "AbortError" || err.message === "Stopped by user") {
        throw err;
      }

      // Auth errors → bubble up immediately
      if (isAuthError(err)) {
        return { success: false, authError: true, error: err };
      }

      // Network errors → retry with growing delay
      if (isNetworkError(err)) {
        if (retryCount >= 10) {
          callbacks?.onError?.(description, err);
          return { success: false, error: err };
        }
        const waitTime = 10 * (retryCount + 1);
        callbacks?.onNetworkRetry?.(retryCount + 1, 10);
        await new Promise((r) => setTimeout(r, waitTime * 1000));
        void client.api; // abort check after sleep
        return apiCall(fn, description, retryCount + 1);
      }

      // Rate limit → backoff, then long sleep after 5 failures
      if (isRateLimitError(err)) {
        if (retryCount >= 5) {
          state.longSleepCount++;
          const sleepHours = 1 + state.longSleepCount;
          const sleepMs = sleepHours * 60 * 60 * 1000;
          const wakeTime = new Date(Date.now() + sleepMs);
          callbacks?.onLongSleep?.(sleepHours, wakeTime);

          // Sleep in 1-min chunks (handles Mac sleep properly)
          const target = Date.now() + sleepMs;
          while (Date.now() < target) {
            void client.api; // abort check
            const remaining = target - Date.now();
            const chunk = Math.min(remaining, 60 * 1000);
            await new Promise((r) => setTimeout(r, chunk));
          }

          callbacks?.onLongSleepWake?.();
          await client.recreateApi();
          return apiCall(fn, description, 0);
        }
        const waitTime = 60 * (retryCount + 1);
        callbacks?.onRateLimitWait?.(waitTime);
        await new Promise((r) => setTimeout(r, waitTime * 1000));
        void client.api; // abort check after sleep
        return apiCall(fn, description, retryCount + 1);
      }

      // Other errors
      callbacks?.onError?.(description, err);
      return { success: false, error: err };
    }
  }

  return apiCall;
}
