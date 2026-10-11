/** Time as the gateway sees it; tests swap in a fake that never really waits. */
export interface Clock {
  now(): number;
  /** Resolves after `ms`, or rejects with `signal.reason` once it aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Sleep that a stop interrupts at once rather than at the end of the wait. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Settle with `promise`, or reject with `signal.reason` if it aborts first. */
export function untilAborted<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export const systemClock: Clock = { now: () => Date.now(), sleep };
