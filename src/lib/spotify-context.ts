import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { type RetryPolicy, createApiCall } from './api-wrapper.js';
import { RequestPacer } from './request-pacer.js';
import { type ReauthStrategy, createSpotifyClient } from './spotify-client.js';
import type {
  ApiCallOptions,
  ApiResult,
  ConfigStore,
  SpotifyClient,
} from './types.js';

export interface SpotifyContext {
  readonly api: SpotifyApi;
  readonly client: SpotifyClient;
  call<T>(fn: () => Promise<T>, description: string): Promise<ApiResult<T>>;
}

/**
 * Create a SpotifyContext from an existing client.
 * Used by the web task-runner where the client is managed per-session.
 */
export function createSpotifyContext(
  client: SpotifyClient,
  callbacks?: ApiCallOptions,
  pacer?: RequestPacer,
  retryPolicy?: Partial<RetryPolicy>,
): SpotifyContext {
  const apiCall = createApiCall(client, callbacks, pacer, retryPolicy);

  return {
    get api() {
      return client.api;
    },
    client,
    call: apiCall,
  };
}

// ── Convenience factory ───────────────────────────────────────────────────────

export interface SpotifyContextConfig {
  configStore: ConfigStore;
  reauth?: ReauthStrategy;
  events?: ApiCallOptions;
  retries?: Partial<RetryPolicy>;
  paceRate?: number;
}

/**
 * One-step creation of a SpotifyContext.
 * Creates client, pacer, and wires everything together.
 */
export function spotifyContext(config: SpotifyContextConfig): SpotifyContext {
  const client = createSpotifyClient({
    configStore: config.configStore,
    reauth: config.reauth,
  });

  const pacer = new RequestPacer(config.paceRate ?? 1);

  return createSpotifyContext(client, config.events, pacer, config.retries);
}
