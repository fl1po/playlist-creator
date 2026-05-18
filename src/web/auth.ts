import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type express from 'express';
import { UserTokenStore } from '../lib/config.js';
import type { AppConfig } from '../lib/types.js';

export interface AuthDeps {
  loadAppConfig: () => AppConfig;
  getOrCreateUserSession: (
    userId: string,
    appConfig: AppConfig,
  ) => {
    userId: string;
    displayName?: string;
    client: { recreateApi(): Promise<unknown> };
  };
  getUserDataDir: (userId: string) => string;
  broadcast: (type: string, data: unknown) => void;
  mainPort: number;
}

export interface AuthManager {
  buildAuthUrl(): string;
  handleAuthCallback(
    req: express.Request,
    res: express.Response,
  ): Promise<void>;
  consumeAuthToken(token: string): string | null;
  getTokensForUser(
    userId: string,
  ): { accessToken: string; refreshToken: string; displayName?: string } | null;
  waitForAuth(): Promise<boolean>;
  readonly authResolve: (() => void) | null;
}

const SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-library-read',
  'user-library-modify',
  'user-read-recently-played',
];

export function createAuthManager(deps: AuthDeps): AuthManager {
  let authState: string | null = null;
  let authResolve: (() => void) | null = null;

  // One-time auth tokens: token -> userId, expires after 60s or first use
  const pendingAuthTokens = new Map<
    string,
    { userId: string; expires: number }
  >();

  // Recently authenticated user tokens (kept for 60s for /api/auth/complete?format=json)
  const recentTokens = new Map<
    string,
    {
      accessToken: string;
      refreshToken: string;
      displayName?: string;
      expires: number;
    }
  >();

  function createAuthToken(userId: string): string {
    const token = crypto.randomBytes(32).toString('hex');
    pendingAuthTokens.set(token, { userId, expires: Date.now() + 60_000 });
    return token;
  }

  function consumeAuthToken(token: string): string | null {
    const entry = pendingAuthTokens.get(token);
    if (!entry) return null;
    pendingAuthTokens.delete(token);
    if (Date.now() > entry.expires) return null;
    return entry.userId;
  }

  async function exchangeCodeForTokens(
    code: string,
    appConfig: AppConfig,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const authHeader = `Basic ${Buffer.from(`${appConfig.clientId}:${appConfig.clientSecret}`).toString('base64')}`;
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: appConfig.redirectUri,
    });

    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new Error(body);
    }

    return tokenRes.json() as Promise<{
      access_token: string;
      refresh_token: string;
    }>;
  }

  async function completeAuth(
    code: string,
    appConfig: AppConfig,
  ): Promise<{ userId: string; displayName: string }> {
    const tokens = await exchangeCodeForTokens(code, appConfig);
    const user = await fetchSpotifyUserId(tokens.access_token);

    // Save tokens to user's data directory (for cookie-based/file mode)
    const dataDir = deps.getUserDataDir(user.id);
    fs.mkdirSync(dataDir, { recursive: true });
    const tokenStore = new UserTokenStore(user.id, dataDir);
    tokenStore.save({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    });

    // Keep tokens in memory for Bearer auth retrieval (opportunistic cleanup of expired entries)
    const now = Date.now();
    for (const [k, v] of recentTokens) {
      if (v.expires < now) recentTokens.delete(k);
    }
    recentTokens.set(user.id, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      displayName: user.displayName,
      expires: now + 60_000,
    });

    // Create/update session in registry
    const session = deps.getOrCreateUserSession(user.id, appConfig);
    session.displayName = user.displayName;
    await session.client.recreateApi();

    return { userId: user.id, displayName: user.displayName };
  }

  function buildAuthSuccessPage(displayName: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Authenticated</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#121212;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
.card{padding:48px 32px}.icon{width:48px;height:48px;margin:0 auto 20px;background:#1a3a25;border-radius:50%;display:flex;align-items:center;justify-content:center}
.icon svg{width:24px;height:24px}h1{font-size:22px;margin-bottom:6px;color:#1DB954}p{color:#999;font-size:14px}
.closing{margin-top:16px;font-size:12px;color:#555}</style></head>
<body><div class="card">
<div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="#1DB954" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
<h1>Authenticated</h1>
<p>Welcome, ${displayName.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c)}</p>
<p class="closing">This window will close automatically...</p>
</div><script>setTimeout(()=>{if(window.opener){window.close()}else{window.location.href='/'}},1500)</script></body></html>`;
  }

  function startCallbackServer(port: number, callbackPath: string) {
    const tmpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname !== callbackPath) {
        res.writeHead(404);
        res.end();
        return;
      }

      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) query[k] = v;

      const { code, state, error } = query;

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Auth Failed</h1><p>You can close this tab.</p>');
        deps.broadcast('log', {
          level: 'error',
          message: `Auth failed: ${error}`,
        });
        tmpServer.close();
        return;
      }

      if (state !== authState) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Auth Failed</h1><p>State mismatch.</p>');
        deps.broadcast('log', {
          level: 'error',
          message: 'Auth failed: state mismatch',
        });
        tmpServer.close();
        return;
      }

      try {
        const appConfig = deps.loadAppConfig();
        const user = await completeAuth(code, appConfig);
        const authToken = createAuthToken(user.userId);
        const tokens = recentTokens.get(user.userId);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(buildAuthSuccessPage(user.displayName));
        deps.broadcast('log', {
          level: 'success',
          message: `Spotify authenticated: ${user.displayName}`,
        });
        deps.broadcast('auth', {
          authenticated: true,
          token: authToken,
          credentials: tokens
            ? {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                userId: user.userId,
                displayName: user.displayName,
              }
            : undefined,
        });
        if (authResolve) {
          authResolve();
          authResolve = null;
        }
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h1>Auth Failed</h1><pre>${String(err)}</pre>`);
        deps.broadcast('log', {
          level: 'error',
          message: `Token exchange failed: ${err}`,
        });
      }

      authState = null;
      tmpServer.close();
    });

    tmpServer.listen(port, '127.0.0.1', () => {
      deps.broadcast('log', {
        level: 'info',
        message: `Listening for auth callback on port ${port}`,
      });
    });

    // Auto-close after 5 minutes if no callback received
    setTimeout(() => tmpServer.close(), 5 * 60 * 1000);
  }

  function buildAuthUrl(): string {
    const config = deps.loadAppConfig();
    authState = crypto.randomBytes(16).toString('hex');
    const redirectUri = config.redirectUri;
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      state: authState,
      show_dialog: 'false',
    });
    // Start temporary callback server if redirect URI is on a different port
    const redirectUrl = new URL(redirectUri);
    const redirectPort = Number(redirectUrl.port) || 80;
    if (redirectPort !== deps.mainPort) {
      startCallbackServer(redirectPort, redirectUrl.pathname);
    }
    return `https://accounts.spotify.com/authorize?${params}`;
  }

  async function handleAuthCallback(
    req: express.Request,
    res: express.Response,
  ) {
    const { code, state, error } = req.query as Record<string, string>;

    if (error) {
      res.send('<h1>Auth Failed</h1><p>You can close this tab.</p>');
      deps.broadcast('log', {
        level: 'error',
        message: `Auth failed: ${error}`,
      });
      return;
    }

    if (state !== authState) {
      res.send('<h1>Auth Failed</h1><p>State mismatch.</p>');
      deps.broadcast('log', {
        level: 'error',
        message: 'Auth failed: state mismatch',
      });
      return;
    }

    try {
      const appConfig = deps.loadAppConfig();
      const user = await completeAuth(code, appConfig);
      const authToken = createAuthToken(user.userId);
      const tokens = recentTokens.get(user.userId);

      res.send(buildAuthSuccessPage(user.displayName));
      deps.broadcast('log', {
        level: 'success',
        message: `Spotify authenticated: ${user.displayName}`,
      });
      deps.broadcast('auth', {
        authenticated: true,
        token: authToken,
        credentials: tokens
          ? {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              userId: user.userId,
              displayName: user.displayName,
            }
          : undefined,
      });
      if (authResolve) {
        authResolve();
        authResolve = null;
      }
    } catch (err) {
      res.send(`<h1>Auth Failed</h1><pre>${String(err)}</pre>`);
      deps.broadcast('log', {
        level: 'error',
        message: `Token exchange failed: ${err}`,
      });
    }

    authState = null;
  }

  function waitForAuth(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      authResolve = () => resolve(true);
      setTimeout(
        () => {
          authResolve = null;
          resolve(false);
        },
        10 * 60 * 1000,
      );
    });
  }

  function getTokensForUser(userId: string): {
    accessToken: string;
    refreshToken: string;
    displayName?: string;
  } | null {
    const entry = recentTokens.get(userId);
    if (!entry) return null;
    recentTokens.delete(userId);
    if (Date.now() > entry.expires) return null;
    return {
      accessToken: entry.accessToken,
      refreshToken: entry.refreshToken,
      displayName: entry.displayName,
    };
  }

  return {
    buildAuthUrl,
    handleAuthCallback,
    consumeAuthToken,
    getTokensForUser,
    waitForAuth,
    get authResolve() {
      return authResolve;
    },
  };
}

export async function fetchSpotifyUserId(
  accessToken: string,
): Promise<{ id: string; displayName: string }> {
  const res = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('Failed to fetch user profile');
  const data = (await res.json()) as { id: string; display_name?: string };
  return { id: data.id, displayName: data.display_name ?? data.id };
}
