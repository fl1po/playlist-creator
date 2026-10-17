/**
 * The longest any one Spotify request may take, body included. Past it the
 * request is cancelled and fails with a `TimeoutError`, which the gateway
 * retries as a network error — a stalled connection must never hang a task.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/** `fetch` that gives up after `timeoutMs`, alongside any signal of its own. */
export function timedFetch(
  timeoutMs = REQUEST_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    return fetchImpl(input, { ...init, signal });
  };
}
