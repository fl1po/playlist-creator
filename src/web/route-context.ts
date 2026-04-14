import fs from 'node:fs';
import path from 'node:path';
import type express from 'express';
import { BridgedConfigStore, UserTokenStore } from '../lib/config.js';
import type { AppConfigStore } from '../lib/config.js';
import { createSpotifyClient } from '../lib/spotify-client.js';
import type { RequestPacer } from '../lib/request-pacer.js';
import type {
  AppConfig,
  SpotifyClient,
  TrustedArtistsFile,
} from '../lib/types.js';
import { UserConfigStore } from '../lib/user-config.js';
import type { AuthManager } from './auth.js';
import type { Broadcaster } from './broadcast.js';
import type { TaskMutex } from './task-mutex.js';
import { getSessionUserId } from './session.js';

export interface UserSession {
  userId: string;
  displayName?: string;
  client: SpotifyClient;
  userConfigStore: UserConfigStore;
  dataDir: string;
}

export interface RouteContext {
  readonly broadcaster: Broadcaster;
  readonly broadcast: (type: string, data: unknown) => void;
  readonly taskMutex: TaskMutex;
  readonly pacer: RequestPacer;
  readonly appConfigStore: AppConfigStore;
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
  loadTrustedArtists(dataDir: string): TrustedArtistsFile | null;
}

export interface RouteContextDeps {
  broadcaster: Broadcaster;
  taskMutex: TaskMutex;
  pacer: RequestPacer;
  appConfigStore: AppConfigStore;
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
    const userConfigStore = new UserConfigStore(
      path.join(dataDir, 'user-config.json'),
    );

    const client = createSpotifyClient({
      configStore,
      onAuthRequired: () =>
        broadcast('log', {
          level: 'warn',
          message:
            'Token expired — opening Spotify login. Task paused, waiting...',
        }),
      onAuthFailed: (err) =>
        broadcast('log', {
          level: 'error',
          message: `Auth failed: ${err.message}`,
        }),
    });

    // Override runAuth to pause and wait for dashboard auth
    client.runAuth = async () => {
      broadcast('log', {
        level: 'warn',
        message:
          'Token expired — opening Spotify login. Task paused, waiting...',
      });
      const url = auth.buildAuthUrl();
      broadcast('auth', { authenticated: false, url });
      return auth.waitForAuth();
    };

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
    const userId = getSessionUserId(req, appConfig.clientSecret);
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return null;
    }
    return getOrCreateUserSession(userId, appConfig);
  }

  function loadTrustedArtists(dataDir: string): TrustedArtistsFile | null {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(dataDir, 'trusted-artists.json'), 'utf8'),
      );
    } catch {
      return null;
    }
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
    loadTrustedArtists,
  };
}
