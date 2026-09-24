import { execSync } from 'node:child_process';
import { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { RetryAfterResponseValidator } from './response-validator.js';
import type { ConfigStore, SpotifyClient, SpotifyConfig } from './types.js';

export type ReauthStrategy =
  | { type: 'cli' }
  | { type: 'custom'; handler: () => Promise<boolean> };

export interface SpotifyClientOptions {
  configStore: ConfigStore;
  reauth?: ReauthStrategy;
  onAuthRequired?: (attempt: number, maxAttempts: number) => void;
  onAuthSuccess?: () => void;
  onAuthFailed?: (error: Error) => void;
  onTokenRefreshed?: () => void;
}

export function createSpotifyClient(opts: SpotifyClientOptions): SpotifyClient {
  const { configStore } = opts;
  const reauth = opts.reauth ?? { type: 'cli' };
  let config: SpotifyConfig = configStore.load();
  let accessToken = config.accessToken ?? '';
  let refreshTokenValue = config.refreshToken ?? '';

  function buildApi(): SpotifyApi {
    return SpotifyApi.withAccessToken(
      config.clientId,
      {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refreshTokenValue,
      },
      { responseValidator: new RetryAfterResponseValidator() },
    );
  }

  let api = buildApi();

  function reloadFromStore(): void {
    config = configStore.load();
    accessToken = config.accessToken ?? '';
    refreshTokenValue = config.refreshToken ?? '';
    api = buildApi();
  }

  async function runAuth(attempt = 1): Promise<boolean> {
    const maxAttempts = 3;
    opts.onAuthRequired?.(attempt, maxAttempts);

    // The handler resolves once new tokens are in the config store (the web
    // login installs them via setTokens); reload so later calls use them.
    if (reauth.type === 'custom') {
      const ok = await reauth.handler();
      if (ok) {
        reloadFromStore();
        opts.onAuthSuccess?.();
      } else {
        opts.onAuthFailed?.(new Error('Re-authentication did not complete'));
      }
      return ok;
    }

    // CLI reauth blocks on the interactive `npm run auth` flow, which writes
    // fresh tokens to the config store; reload them from there.
    try {
      execSync('npm run auth', { stdio: 'inherit' });
      reloadFromStore();
      opts.onAuthSuccess?.();
      return true;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      opts.onAuthFailed?.(err);

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 10000));
        return runAuth(attempt + 1);
      }
      return false;
    }
  }

  async function refreshToken(retryCount = 0): Promise<string> {
    const authHeader = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', refreshTokenValue);

    let response: Response;
    try {
      response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
      });
    } catch (e) {
      if (retryCount < 5) {
        const waitTime = 10 * (retryCount + 1);
        await new Promise((r) => setTimeout(r, waitTime * 1000));
        return refreshToken(retryCount + 1);
      }
      throw new Error(
        `Token refresh network error after 5 retries: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Refresh token rejected (revoked/expired) — only a full reauth recovers.
    if (!response.ok) {
      const authSuccess = await runAuth();
      if (!authSuccess) {
        throw new Error(
          'Authentication failed. Please run npm run auth manually.',
        );
      }
      return accessToken;
    }

    const data = await response.json();
    accessToken = data.access_token;
    if (data.refresh_token) {
      refreshTokenValue = data.refresh_token;
    }

    config.accessToken = accessToken;
    config.refreshToken = refreshTokenValue;
    configStore.save(config);
    opts.onTokenRefreshed?.();

    return accessToken;
  }

  async function recreateApi(): Promise<SpotifyApi> {
    await refreshToken();
    api = buildApi();
    return api;
  }

  function setTokens(tokens: { accessToken: string; refreshToken: string }) {
    accessToken = tokens.accessToken;
    refreshTokenValue = tokens.refreshToken;
    config.accessToken = accessToken;
    config.refreshToken = refreshTokenValue;
    configStore.save(config);
    api = buildApi();
  }

  return {
    get api() {
      return api;
    },
    refreshToken,
    recreateApi,
    runAuth,
    setTokens,
  };
}
