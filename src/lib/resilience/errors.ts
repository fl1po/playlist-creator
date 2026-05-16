import { RateLimitError } from '../rate-limit-error.js';

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

/**
 * Classify a caught error into a structured kind.
 *
 * Priority: instanceof checks → statusCode property → string-matching fallback.
 */
export function classifyError(e: Error): ClassifiedError {
  // 1. Known error types
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
    if (code >= 502 && code <= 504)
      return { kind: 'server', statusCode: code, original: e };
    return { kind: 'unknown', statusCode: code, original: e };
  }

  // 2. String-matching fallback for errors from the Spotify SDK or network layer
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
