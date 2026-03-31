import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { createApiCall } from './api-wrapper.js';
import type { RequestPacer } from './request-pacer.js';
import type { ApiCallOptions, ApiResult, SpotifyClient } from './types.js';

export interface SpotifyContext {
  readonly api: SpotifyApi;
  readonly client: SpotifyClient;
  call<T>(fn: () => Promise<T>, description: string): Promise<ApiResult<T>>;
}

export function createSpotifyContext(
  client: SpotifyClient,
  callbacks?: ApiCallOptions,
  pacer?: RequestPacer,
): SpotifyContext {
  const apiCall = createApiCall(client, callbacks, pacer);

  return {
    get api() {
      return client.api;
    },
    client,
    call: apiCall,
  };
}
