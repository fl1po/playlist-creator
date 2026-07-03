import fs from 'node:fs';
import path from 'node:path';
import type express from 'express';
import { TRUSTED_ARTISTS } from '../lib/cache-files.js';
import {
  BridgedConfigStore,
  InMemoryTokenStore,
  UserTokenStore,
} from '../lib/config.js';
import type { IAppConfigStore } from '../lib/config.js';
import { createDurableCache } from '../lib/durable-cache.js';
import type { RequestPacer } from '../lib/request-pacer.js';
import { createSpotifyClient } from '../lib/spotify-client.js';
import type {
  AppConfig,
  SpotifyClient,
  TrustedArtistsFile,
} from '../lib/types.js';
import { type IUserConfigStore, UserConfigStore } from '../lib/user-config.js';
import type { AuthManager } from './auth.js';
import type { Broadcaster } from './broadcast.js';
import {
  RedisUserConfigStore,
  isRedisConfigured,
} from './redis-config-store.js';
import {
  getBearerToken,
  getRefreshToken,
  getSessionUserId,
} from './session.js';
import type { TaskMutex } from './task-mutex.js';

export interface UserSession {
  userId: string;
  displayName?: string;
  client: SpotifyClient;
  userConfigStore: IUserConfigStore;
  dataDir: string;
}

export interface RouteContext {
  readonly broadcaster: Broadcaster;
  readonly broadcast: (type: string, data: unknown) => void;
  readonly taskMutex: TaskMutex;
  readonly pacer: RequestPacer;
  readonly appConfigStore: IAppConfigStore;
  readonly auth: AuthManager;
  readonly sessions: Map<string, UserSession>;
  readonly searchedArtists: Set<string>;
  readonly usersDir: string;
  readonly projectRoot: string;
  readonly port: number;

  loadAppConfig(): AppConfig;
  getUserDataDir(userId: string): string;
  getOrCreateUserSession(userId: string, appConfig: AppConfig): UserSession;
  requireSession(
    req: express.Request,
    res: express.Response,
  ): UserSession | null;
  loadTrustedArtistsOrRedis(
    session: UserSession,
  ): Promise<TrustedArtistsFile | null>;
}

export interface RouteContextDeps {
  broadcaster: Broadcaster;
  taskMutex: TaskMutex;
  pacer: RequestPacer;
  appConfigStore: IAppConfigStore;
  auth: AuthManager;
  usersDir: string;
  projectRoot: string;
  port: number;
}

export function createRouteContext(deps: RouteContextDeps): RouteContext {
  const {
    broadcaster,
    taskMutex,
    pacer,
    appConfigStore,
    auth,
    usersDir,
    projectRoot,
    port,
  } = deps;
  const broadcast = broadcaster.broadcast;
  const sessions = new Map<string, UserSession>();
  const searchedArtists = new Set<string>();
  const bearerTokenCache = new Map<string, string>();
  const bearerRefreshCache = new Map<string, string>();

  function buildSpotifyClient(configStore: BridgedConfigStore): SpotifyClient {
    return createSpotifyClient({
      configStore,
      reauth: {
        type: 'custom',
        handler: async () => {
          broadcast('log', {
            level: 'warn',
            message:
              'Token expired — opening Spotify login. Task paused, waiting...',
          });
          const url = auth.buildAuthUrl();
          broadcast('auth', { authenticated: false, url });
          return auth.waitForAuth();
        },
      },
      onAuthFailed: (err) =>
        broadcast('log', {
          level: 'error',
          message: `Auth failed: ${err.message}`,
        }),
    });
  }

  function loadAppConfig(): AppConfig {
    return appConfigStore.load();
  }

  function getUserDataDir(userId: string): string {
    return path.join(usersDir, userId);
  }

  function getOrCreateUserSession(
    userId: string,
    appConfig: AppConfig,
  ): UserSession {
    const existing = sessions.get(userId);
    if (existing) return existing;

    const dataDir = getUserDataDir(userId);
    fs.mkdirSync(dataDir, { recursive: true });

    const tokenStore = new UserTokenStore(userId, dataDir);
    const configStore = new BridgedConfigStore(appConfig, tokenStore);
    const userConfigStore: IUserConfigStore = isRedisConfigured()
      ? new RedisUserConfigStore(userId)
      : new UserConfigStore(path.join(dataDir, 'user-config.json'));

    const client = buildSpotifyClient(configStore);

    const session: UserSession = { userId, client, userConfigStore, dataDir };
    sessions.set(userId, session);
    return session;
  }

  function requireSession(
    req: express.Request,
    res: express.Response,
  ): UserSession | null {
    let appConfig: AppConfig;
    try {
      appConfig = loadAppConfig();
    } catch {
      res.status(401).json({ error: 'Not authenticated' });
      return null;
    }

    // Try Bearer token auth first (stateless mode)
    const bearerToken = getBearerToken(req);
    if (bearerToken) {
      const userId = req.headers['x-user-id'] as string | undefined;
      if (!userId) {
        res
          .status(401)
          .json({ error: 'X-User-Id header required with Bearer auth' });
        return null;
      }
      const refreshToken = getRefreshToken(req);
      if (!refreshToken) {
        // Without a refresh token we can't rebuild server-side state after a
        // restart. Refuse rather than create a broken session that would
        // trigger an infinite re-auth loop on the first token refresh.
        res
          .status(401)
          .json({ error: 'X-Refresh-Token header required with Bearer auth' });
        return null;
      }
      return getOrCreateBearerSession(
        userId,
        appConfig,
        bearerToken,
        refreshToken,
      );
    }

    // Fall back to cookie auth
    const userId = getSessionUserId(req, appConfig.clientSecret);
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return null;
    }
    return getOrCreateUserSession(userId, appConfig);
  }

  function getOrCreateBearerSession(
    userId: string,
    appConfig: AppConfig,
    accessToken: string,
    refreshToken: string,
  ): UserSession {
    const existing = sessions.get(userId);
    if (existing) {
      const cachedRefresh = bearerRefreshCache.get(userId);
      const cachedAccess = bearerTokenCache.get(userId);
      // Rebuild the Spotify client whenever EITHER token differs from what
      // we last installed — covers token rotation AND sessions that were
      // created with a stale or empty refresh token before this fix.
      if (cachedAccess !== accessToken || cachedRefresh !== refreshToken) {
        const tokenStore = new InMemoryTokenStore(
          { accessToken, refreshToken },
          (tokens) => broadcast('data:save', { key: 'tokens', value: tokens }),
        );
        const configStore = new BridgedConfigStore(appConfig, tokenStore);
        existing.client = buildSpotifyClient(configStore);
        bearerTokenCache.set(userId, accessToken);
        bearerRefreshCache.set(userId, refreshToken);
      }
      return existing;
    }

    const tokenStore = new InMemoryTokenStore(
      { accessToken, refreshToken },
      (tokens) => broadcast('data:save', { key: 'tokens', value: tokens }),
    );
    const configStore = new BridgedConfigStore(appConfig, tokenStore);
    const userConfigStore: IUserConfigStore = isRedisConfigured()
      ? new RedisUserConfigStore(userId)
      : new UserConfigStore(path.join(usersDir, userId, 'user-config.json'));

    const client = buildSpotifyClient(configStore);
    bearerTokenCache.set(userId, accessToken);
    bearerRefreshCache.set(userId, refreshToken);

    const session: UserSession = {
      userId,
      client,
      userConfigStore,
      dataDir: path.join(usersDir, userId),
    };
    sessions.set(userId, session);
    return session;
  }

  // Load trusted artists from the local file, falling back to the durable
  // Redis copy (e.g. ephemeral filesystem). Backend is the source of truth.
  async function loadTrustedArtistsOrRedis(
    session: UserSession,
  ): Promise<TrustedArtistsFile | null> {
    return createDurableCache({
      userId: session.userId,
      dataDir: session.dataDir,
    }).load(TRUSTED_ARTISTS);
  }

  return {
    broadcaster,
    broadcast,
    taskMutex,
    pacer,
    appConfigStore,
    auth,
    sessions,
    searchedArtists,
    usersDir,
    projectRoot,
    port,
    loadAppConfig,
    getUserDataDir,
    getOrCreateUserSession,
    requireSession,
    loadTrustedArtistsOrRedis,
  };
}
