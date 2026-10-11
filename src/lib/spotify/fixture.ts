import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { isAbort } from './errors.js';
import type { ApiResult, SpotifyGateway } from './gateway.js';

/**
 * Test adapter: runs each call straight against a fake SDK. No pacing, no
 * retries. A stop or `SpotifyAuthLost` thrown by the fake propagates as it
 * would from the real gateway; any other throw becomes a failed result.
 */
export function fixtureGateway(
  api: unknown,
  opts: { signal?: AbortSignal } = {},
): SpotifyGateway {
  return {
    signal: opts.signal,
    async call<T>(fn: (api: SpotifyApi) => Promise<T>): Promise<ApiResult<T>> {
      opts.signal?.throwIfAborted();
      try {
        return { success: true, data: await fn(api as SpotifyApi) };
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        if (isAbort(error) || error.name === 'SpotifyAuthLost') throw error;
        return { success: false, error, kind: 'unknown' };
      }
    },
  };
}
