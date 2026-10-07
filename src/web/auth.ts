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
    client: {
      setTokens(tokens: { accessToken: string; refreshToken: string }): void;
    };
  };
  getUserDataDir: (userId: string) => string;
  broadcast: (type: string, data: unknown) => void;
  broadcastTo: (userId: string, type: string, data: unknown) => void;
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
  /** Resolves true once `userId` completes a login, false after 10 minutes. */
  waitForAuth(userId: string): Promise<boolean>;
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

const AUTH_STATE_TTL_MS = 10 * 60 * 1000;

function escapeHtml(text: string): string {
  return text.replace(
    /[<>&"']/g,
    (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[
        c
      ] ?? c,
  );
}

export function createAuthManager(deps: AuthDeps): AuthManager {
  // Several logins can be in flight at once (different users, or one user's
  // reauth racing a manual login), so every issued state stays valid until
  // used or expired.
  const pendingStates = new Map<string, number>();
  const authWaiters = new Map<string, Set<() => void>>();

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

  function issueState(): string {
    const now = Date.now();
    for (const [s, expires] of pendingStates) {
      if (expires < now) pendingStates.delete(s);
    }
    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, now + AUTH_STATE_TTL_MS);
    return state;
  }

  function consumeState(state: string | undefined): boolean {
    if (!state) return false;
    const expires = pendingStates.get(state);
    if (expires === undefined) return false;
    pendingStates.delete(state);
    return Date.now() <= expires;
  }

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

    const session = deps.getOrCreateUserSession(user.id, appConfig);
    session.displayName = user.displayName;
    // Install the new tokens directly rather than via recreateApi(): if a task
    // is waiting on reauth, the client still holds the rejected refresh token,
    // and refreshing with it would trigger a second, nested reauth.
    session.client.setTokens({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    });

    return { userId: user.id, displayName: user.displayName };
  }

  function buildAuthSuccessPage(
    displayName: string,
    authToken: string,
    openerOrigins: string[] | null,
  ): string {
    // null = same origin as the app; otherwise the callback server runs on its
    // own port and must name the app's origin(s) explicitly.
    const targets = JSON.stringify(openerOrigins);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Authenticated</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#121212;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
.card{padding:48px 32px}.icon{width:48px;height:48px;margin:0 auto 20px;background:#1a3a25;border-radius:50%;display:flex;align-items:center;justify-content:center}
.icon svg{width:24px;height:24px}h1{font-size:22px;margin-bottom:6px;color:#1DB954}p{color:#999;font-size:14px}
.closing{margin-top:16px;font-size:12px;color:#555}</style></head>
<body data-token="${authToken}"><div class="card">
<div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="#1DB954" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
<h1>Authenticated</h1>
<p>Welcome, ${escapeHtml(displayName)}</p>
<p class="closing">This window will close automatically...</p>
</div><script>setTimeout(()=>{const t=document.body.dataset.token;if(window.opener){for(const o of (${targets}??[location.origin])){try{window.opener.postMessage({type:'spotify-auth',token:t},o)}catch{}}window.close()}else{window.location.href='/?auth_token='+encodeURIComponent(t)}},1500)</script></body></html>`;
  }

  /** Shared by the main-app route and the standalone callback server. Returns the page HTML. */
  async function processCallback(
    query: Record<string, string | undefined>,
    openerOrigins: string[] | null,
  ): Promise<string> {
    const { code, state, error } = query;

    if (error) {
      deps.broadcast('log', {
        level: 'error',
        message: `Auth failed: ${error}`,
      });
      return '<h1>Auth Failed</h1><p>You can close this tab.</p>';
    }

    if (!(consumeState(state) && code)) {
      deps.broadcast('log', {
        level: 'error',
        message: 'Auth failed: state mismatch',
      });
      return '<h1>Auth Failed</h1><p>State mismatch.</p>';
    }

    try {
      const appConfig = deps.loadAppConfig();
      const user = await completeAuth(code, appConfig);
      const authToken = createAuthToken(user.userId);
      // Credentials never ride the event stream: the popup hands the one-time
      // token to its opener (see buildAuthSuccessPage), and the user's other
      // tabs just learn that auth completed.
      deps.broadcastTo(user.userId, 'log', {
        level: 'success',
        message: `Spotify authenticated: ${user.displayName}`,
      });
      deps.broadcastTo(user.userId, 'auth', { authenticated: true });
      const waiters = authWaiters.get(user.userId);
      authWaiters.delete(user.userId);
      for (const resolve of waiters ?? []) resolve();
      return buildAuthSuccessPage(user.displayName, authToken, openerOrigins);
    } catch (err) {
      deps.broadcast('log', {
        level: 'error',
        message: `Token exchange failed: ${err}`,
      });
      return `<h1>Auth Failed</h1><pre>${escapeHtml(String(err))}</pre>`;
    }
  }

  // Used when the redirect URI points at a different port than the app (local
  // dev). One server serves every pending login and closes once none remain, or
  // once no new login has started for a full state lifetime.
  let callbackServer: http.Server | null = null;
  let callbackServerTimer: NodeJS.Timeout | null = null;

  function closeCallbackServer() {
    if (callbackServerTimer) clearTimeout(callbackServerTimer);
    callbackServerTimer = null;
    callbackServer?.close();
    callbackServer = null;
  }

  function ensureCallbackServer(port: number, callbackPath: string) {
    if (callbackServerTimer) clearTimeout(callbackServerTimer);
    callbackServerTimer = setTimeout(
      closeCallbackServer,
      AUTH_STATE_TTL_MS,
    ).unref();
    if (callbackServer) return;

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname !== callbackPath) {
        res.writeHead(404);
        res.end();
        return;
      }

      const html = await processCallback(Object.fromEntries(url.searchParams), [
        `http://localhost:${deps.mainPort}`,
        `http://127.0.0.1:${deps.mainPort}`,
      ]);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      if (pendingStates.size === 0) closeCallbackServer();
    });
    callbackServer = server;

    server.on('error', (err) => {
      deps.broadcast('log', {
        level: 'error',
        message: `Auth callback server failed: ${err.message}`,
      });
      if (callbackServer === server) closeCallbackServer();
    });
    server.listen(port, '127.0.0.1', () => {
      deps.broadcast('log', {
        level: 'info',
        message: `Listening for auth callback on port ${port}`,
      });
    });
  }

  function buildAuthUrl(): string {
    const config = deps.loadAppConfig();
    const state = issueState();
    const redirectUri = config.redirectUri;
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      state,
      show_dialog: 'false',
    });
    const redirectUrl = new URL(redirectUri);
    const redirectPort = Number(redirectUrl.port) || 80;
    if (redirectPort !== deps.mainPort) {
      ensureCallbackServer(redirectPort, redirectUrl.pathname);
    }
    return `https://accounts.spotify.com/authorize?${params}`;
  }

  async function handleAuthCallback(
    req: express.Request,
    res: express.Response,
  ) {
    res.send(
      await processCallback(
        req.query as Record<string, string | undefined>,
        null,
      ),
    );
  }

  function waitForAuth(userId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const onAuth = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        authWaiters.get(userId)?.delete(onAuth);
        resolve(false);
      }, AUTH_STATE_TTL_MS).unref();
      let waiters = authWaiters.get(userId);
      if (!waiters) {
        waiters = new Set();
        authWaiters.set(userId, waiters);
      }
      waiters.add(onAuth);
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
