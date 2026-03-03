import { SpotifyApi } from "@spotify/web-api-ts-sdk";
import type { ApiCallOptions, ApiResult, SpotifyClient } from "./types.js";
import { RateLimitError } from "./rate-limit-error.js";

/** Sleep in 1-second chunks, checking abort via client.api between each. */
async function abortableSleep(ms: number, client: SpotifyClient): Promise<void> {
  const target = Date.now() + ms;
  while (Date.now() < target) {
    void client.api; // throws if aborted
    const remaining = target - Date.now();
    await new Promise((r) => setTimeout(r, Math.min(remaining, 1000)));
  }
}

function isRateLimitError(e: Error): boolean {
  if (e instanceof RateLimitError) return true;
  const msg = e.message?.toLowerCase() ?? "";
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests")
  );
}

function getRetryAfterSeconds(e: Error): number | null {
  if (e instanceof RateLimitError) return e.retryAfterSeconds;
  return null;
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

function isServerError(e: Error): boolean {
  const msg = e.message ?? "";
  return msg.includes("502") || msg.includes("503") || msg.includes("504");
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

      // Server errors (502/503/504) → retry with short delay
      if (isServerError(err)) {
        if (retryCount >= 3) {
          callbacks?.onError?.(description, err);
          return { success: false, error: err };
        }
        await abortableSleep(5000 * (retryCount + 1), client);
        return apiCall(fn, description, retryCount + 1);
      }

      // Network errors → retry with growing delay
      if (isNetworkError(err)) {
        if (retryCount >= 10) {
          callbacks?.onError?.(description, err);
          return { success: false, error: err };
        }
        callbacks?.onNetworkRetry?.(retryCount + 1, 10);
        await abortableSleep(10000 * (retryCount + 1), client);
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
          await abortableSleep(sleepMs, client);
          callbacks?.onLongSleepWake?.();
          await client.recreateApi();
          return apiCall(fn, description, 0);
        }
        const retryAfter = getRetryAfterSeconds(err);
        const waitTime = retryAfter !== null
          ? retryAfter + 1          // Spotify's value + 1s buffer
          : 60 * (retryCount + 1);  // fallback when header missing
        callbacks?.onRateLimitWait?.(waitTime);
        await abortableSleep(waitTime * 1000, client);
        return apiCall(fn, description, retryCount + 1);
      }

      // Other errors
      callbacks?.onError?.(description, err);
      return { success: false, error: err };
    }
  }

  return apiCall;
}
