export type ErrorKind =
  | 'rate_limit'
  | 'auth'
  | 'server'
  | 'network'
  | 'unknown';

export interface ClassifiedError {
  kind: ErrorKind;
  statusCode?: number;
  retryAfterSeconds?: number;
  original: Error;
}

/** An HTTP error with a known status code, thrown by the response validator. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** A 429, carrying Spotify's Retry-After when it sent one. */
export class RateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number | null) {
    super('The app has exceeded its rate limits.');
    this.name = 'RateLimitError';
  }
}

/**
 * The owner stopped the task. Abort signals are aborted with this as their
 * reason, so `signal.throwIfAborted()` throws it.
 */
export class TaskAborted extends Error {
  constructor() {
    super('Stopped by user');
    this.name = 'TaskAborted';
  }
}

/**
 * Spotify auth is gone and the gateway could not get it back: the refresh
 * token was rejected and re-authentication failed or isn't available here.
 * Nothing a caller does can recover from it.
 */
export class SpotifyAuthLost extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SpotifyAuthLost';
  }
}

/** Whether `err` means the work was stopped rather than that it failed. */
export function isAbort(err: unknown): boolean {
  return (
    err instanceof TaskAborted ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

/**
 * Classify a caught error into a structured kind.
 *
 * Priority: known error classes (RateLimitError, HttpError) → timeouts → message
 * string-matching fallback for errors from the SDK or network layer.
 */
export function classifyError(e: Error): ClassifiedError {
  if (e instanceof RateLimitError) {
    return {
      kind: 'rate_limit',
      statusCode: 429,
      retryAfterSeconds: e.retryAfterSeconds ?? undefined,
      original: e,
    };
  }

  if (e instanceof HttpError) {
    const code = e.statusCode;
    if (code === 401) return { kind: 'auth', statusCode: code, original: e };
    // Spotify's 500s are usually transient, so they're retried like 502–504.
    if (code === 500 || (code >= 502 && code <= 504))
      return { kind: 'server', statusCode: code, original: e };
    return { kind: 'unknown', statusCode: code, original: e };
  }

  // A request cut off by its timeout (see http.ts).
  if (e.name === 'TimeoutError') return { kind: 'network', original: e };

  const msg = e.message?.toLowerCase() ?? '';

  if (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  ) {
    return { kind: 'rate_limit', statusCode: 429, original: e };
  }

  if (
    msg.includes('401') ||
    msg.includes('invalid_request') ||
    msg.includes('invalid_grant') ||
    msg.includes('refresh token') ||
    msg.includes('expired token') ||
    msg.includes('re-authenticate') ||
    msg.includes('unauthorized') ||
    msg.includes('bad request')
  ) {
    return { kind: 'auth', statusCode: 401, original: e };
  }

  if (msg.includes('502') || msg.includes('503') || msg.includes('504')) {
    return { kind: 'server', original: e };
  }

  if (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    msg.includes('socket')
  ) {
    return { kind: 'network', original: e };
  }

  return { kind: 'unknown', original: e };
}
