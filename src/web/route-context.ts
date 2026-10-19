import fs from 'node:fs';
import path from 'node:path';
import type express from 'express';
import type { IAppConfigStore } from '../lib/config.js';
import {
  BridgedConfigStore,
  InMemoryTokenStore,
  type ITokenStore,
  UserTokenStore,
} from '../lib/config.js';
import type { CallStats } from '../lib/spotify/call-stats.js';
import {
  createSpotifyGateway,
  type RequestPacer,
  type SessionGateway,
} from '../lib/spotify/gateway.js';
import type { AppConfig } from '../lib/types.js';
import {
  durableUserData,
  localUserData,
  type RedisPort,
  type UserData,
} from '../lib/user-data/index.js';
import type { AuthManager } from './auth.js';
import type { Broadcaster } from './broadcast.js';
import {
  getBearerToken,
  getRefreshToken,
  getSessionUserId,
} from './session.js';

export interface UserSession {
  userId: string;
  displayName?: string;
  /** The user's Spotify gateway; routes call it on the interactive lane. */
  gateway: SessionGateway;
  /** The user's user data: durable when the server has Redis, else local. */
  data: UserData;
}

export interface RouteContext {
  readonly broadcaster: Broadcaster;
  readonly broadcast: (type: string, data: unknown) => void;
  readonly pacer: RequestPacer;
  readonly appConfigStore: IAppConfigStore;
  readonly auth: AuthManager;
  readonly sessions: Map<string, UserSession>;
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
}

export interface RouteContextDeps {
  broadcaster: Broadcaster;
  pacer: RequestPacer;
  /** Server-wide tally of each user's Spotify calls. */
  callStats: CallStats;
  appConfigStore: IAppConfigStore;
  auth: AuthManager;
  usersDir: string;
  projectRoot: string;
  port: number;
  /** The server's one Redis; null keeps every user's data local. */
  redis: RedisPort | null;
}

export function createRouteContext(deps: RouteContextDeps): RouteContext {
  const {
    broadcaster,
    pacer,
    callStats,
    appConfigStore,
    auth,
    usersDir,
    projectRoot,
    port,
    redis,
  } = deps;
  const broadcast = broadcaster.broadcast;
  const sessions = new Map<string, UserSession>();
  const bearerTokenCache = new Map<string, string>();
  const bearerRefreshCache = new Map<string, string>();

  // Everything here carries the user's own auth state (login URL, tokens), so
  // it goes to that user's clients only — never the global broadcast.
  function buildGateway(
    configStore: BridgedConfigStore,
    userId: string,
  ): SessionGateway {
    return createSpotifyGateway({
      configStore,
      pacer,
      onCall: (call) => callStats.record(userId, call),
      // Only tasks wait for a login; completing it installs the new tokens
      // through the session gateway's setTokens.
      reauth: async () => {
        broadcaster.broadcastTo(userId, 'log', {
          level: 'warn',
          message:
            'Token expired — opening Spotify login. Task paused, waiting...',
        });
        const url = auth.buildAuthUrl();
        broadcaster.broadcastTo(userId, 'auth', {
          authenticated: false,
          url,
        });
        const ok = await auth.waitForAuth(userId);
        if (!ok) {
          broadcaster.broadcastTo(userId, 'log', {
            level: 'error',
            message: 'Auth failed: re-authentication did not complete',
          });
        }
        return ok;
      },
      authLostHint: 'Log in to Spotify again.',
    });
  }

  function pushTokens(userId: string) {
    return (tokens: unknown) =>
      broadcaster.broadcastTo(userId, 'data:save', {
        key: 'tokens',
        value: tokens,
      });
  }

  function loadAppConfig(): AppConfig {
    return appConfigStore.load();
  }

  function getUserDataDir(userId: string): string {
    return path.join(usersDir, userId);
  }

  /** One user's session: their gateway over `tokenStore`, and their data. */
  function buildSession(
    userId: string,
    appConfig: AppConfig,
    tokenStore: ITokenStore,
  ): UserSession {
    const dataDir = getUserDataDir(userId);
    const session: UserSession = {
      userId,
      gateway: buildGateway(
        new BridgedConfigStore(appConfig, tokenStore),
        userId,
      ),
      data: redis
        ? durableUserData({ userId, dataDir, redis })
        : localUserData(dataDir),
    };
    sessions.set(userId, session);
    return session;
  }

  function getOrCreateUserSession(
    userId: string,
    appConfig: AppConfig,
  ): UserSession {
    const existing = sessions.get(userId);
    if (existing) return existing;

    const dataDir = getUserDataDir(userId);
    fs.mkdirSync(dataDir, { recursive: true });
    return buildSession(userId, appConfig, new UserTokenStore(userId, dataDir));
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

    // Bearer (stateless) mode trusts X-User-Id only because the bearerIdentity
    // middleware has already proved the token belongs to that user.
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
      // Install the browser's tokens whenever EITHER differs from what it
      // last sent — covers token rotation AND a session first built with a
      // stale refresh token. A running task picks them up on its next call.
      if (cachedAccess !== accessToken || cachedRefresh !== refreshToken) {
        existing.gateway.setTokens({ accessToken, refreshToken });
        bearerTokenCache.set(userId, accessToken);
        bearerRefreshCache.set(userId, refreshToken);
      }
      return existing;
    }

    bearerTokenCache.set(userId, accessToken);
    bearerRefreshCache.set(userId, refreshToken);
    return buildSession(
      userId,
      appConfig,
      new InMemoryTokenStore({ accessToken, refreshToken }, pushTokens(userId)),
    );
  }

  return {
    broadcaster,
    broadcast,
    pacer,
    appConfigStore,
    auth,
    sessions,
    usersDir,
    projectRoot,
    port,
    loadAppConfig,
    getUserDataDir,
    getOrCreateUserSession,
    requireSession,
  };
}
