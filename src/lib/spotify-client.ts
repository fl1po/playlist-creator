import { execSync } from "node:child_process";
import { SpotifyApi } from "@spotify/web-api-ts-sdk";
import type { ConfigStore, SpotifyClient, SpotifyConfig } from "./types.js";
import { RetryAfterResponseValidator } from "./response-validator.js";

export interface SpotifyClientOptions {
  configStore: ConfigStore;
  onAuthRequired?: (attempt: number, maxAttempts: number) => void;
  onAuthSuccess?: () => void;
  onAuthFailed?: (error: Error) => void;
  onTokenRefreshed?: () => void;
}

export function createSpotifyClient(
  opts: SpotifyClientOptions,
): SpotifyClient {
  const { configStore } = opts;
  let config: SpotifyConfig = configStore.load();
  let accessToken = config.accessToken ?? "";
  let refreshTokenValue = config.refreshToken ?? "";

  function buildApi(): SpotifyApi {
    return SpotifyApi.withAccessToken(config.clientId, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshTokenValue,
    }, { responseValidator: new RetryAfterResponseValidator() });
  }

  let api = buildApi();

  async function runAuth(attempt = 1): Promise<boolean> {
    const maxAttempts = 3;
    opts.onAuthRequired?.(attempt, maxAttempts);

    try {
      execSync("npm run auth", { stdio: "inherit" });
      config = configStore.load();
      accessToken = config.accessToken ?? "";
      refreshTokenValue = config.refreshToken ?? "";
      api = buildApi();
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
    const authHeader = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
    const params = new URLSearchParams();
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", refreshTokenValue);

    let response: Response;
    try {
      response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/x-www-form-urlencoded",
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

    if (!response.ok) {
      const authSuccess = await runAuth();
      if (!authSuccess) {
        throw new Error(
          "Authentication failed. Please run npm run auth manually.",
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

  return {
    get api() {
      return api;
    },
    refreshToken,
    recreateApi,
    runAuth,
  };
}
