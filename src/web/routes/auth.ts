import { Router } from 'express';
import type { RouteContext } from '../route-context.js';
import { clearSessionCookie, setSessionCookie } from '../session.js';

export function authRoutes(ctx: RouteContext): Router {
  const router = Router();

  router.get('/api/auth', (_req, res) => {
    res.json({ ok: true, url: ctx.auth.buildAuthUrl() });
  });

  router.get('/callback', (req, res) => ctx.auth.handleAuthCallback(req, res));

  router.get('/api/auth/complete', (req, res) => {
    const token = req.query.token as string;
    const format = req.query.format as string | undefined;
    if (!token) {
      res.status(400).send('<h1>Missing token</h1>');
      return;
    }
    const userId = ctx.auth.consumeAuthToken(token);
    if (!userId) {
      res.status(400).send('<h1>Invalid or expired token</h1>');
      return;
    }

    // JSON format: return tokens for client-side storage (Bearer auth mode)
    if (format === 'json') {
      const tokens = ctx.auth.getTokensForUser(userId);
      if (!tokens) {
        res.status(500).json({ error: 'Tokens not found' });
        return;
      }
      res.json({ userId, ...tokens });
      return;
    }

    // HTML format: set cookie (legacy mode)
    const appConfig = ctx.loadAppConfig();
    setSessionCookie(res, userId, appConfig.clientSecret);
    res.send(
      `<h1>Authenticated!</h1><p>You can close this tab and return to the <a href="http://localhost:${ctx.port}">dashboard</a>.</p>`,
    );
  });

  router.get('/api/auth/status', async (req, res) => {
    let appConfig;
    try {
      appConfig = ctx.loadAppConfig();
    } catch {
      res.json({ authenticated: false, reason: 'no_session' });
      return;
    }

    const { getBearerToken, getSessionUserId } = await import('../session.js');

    // Try Bearer token first
    const bearerToken = getBearerToken(req);
    if (bearerToken) {
      try {
        const profileRes = await fetch('https://api.spotify.com/v1/me', {
          headers: { Authorization: `Bearer ${bearerToken}` },
        });
        if (!profileRes.ok) {
          res.json({ authenticated: false, reason: 'expired' });
          return;
        }
        const profile = (await profileRes.json()) as {
          id: string;
          display_name?: string;
        };
        res.json({
          authenticated: true,
          userId: profile.id,
          displayName: profile.display_name ?? profile.id,
        });
      } catch {
        res.json({ authenticated: false, reason: 'expired' });
      }
      return;
    }

    // Fall back to cookie
    const userId = getSessionUserId(req, appConfig.clientSecret);
    if (!userId) {
      res.json({ authenticated: false, reason: 'no_session' });
      return;
    }
    try {
      const session = ctx.getOrCreateUserSession(userId, appConfig);
      await session.client.refreshToken();
      const profile = await session.client.api.currentUser.profile();
      session.displayName = profile.display_name ?? profile.id;
      res.json({ authenticated: true, displayName: session.displayName });
    } catch {
      res.json({ authenticated: false, reason: 'expired' });
    }
  });

  router.post('/api/auth/refresh', async (req, res) => {
    let appConfig;
    try {
      appConfig = ctx.loadAppConfig();
    } catch {
      res.status(400).json({ ok: false, error: 'No app config' });
      return;
    }

    const refreshToken = req.body?.refreshToken as string | undefined;
    if (!refreshToken) {
      res.status(400).json({ ok: false, error: 'Missing refreshToken' });
      return;
    }

    try {
      const authHeader = `Basic ${Buffer.from(`${appConfig.clientId}:${appConfig.clientSecret}`).toString('base64')}`;
      const params = new URLSearchParams();
      params.append('grant_type', 'refresh_token');
      params.append('refresh_token', refreshToken);

      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text().catch(() => '');
        console.error(
          `Spotify token refresh failed: ${tokenRes.status} ${body}`,
        );
        // 4xx other than 429 = refresh token rejected (revoked/expired). Permanent.
        const permanent =
          tokenRes.status >= 400 &&
          tokenRes.status < 500 &&
          tokenRes.status !== 429;
        res.json({
          ok: false,
          error: 'Refresh failed',
          status: tokenRes.status,
          permanent,
        });
        return;
      }

      const data = (await tokenRes.json()) as {
        access_token: string;
        refresh_token?: string;
      };
      res.json({
        ok: true,
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? refreshToken,
      });
    } catch (err) {
      console.error('Spotify token refresh threw:', err);
      res.json({ ok: false, error: 'Refresh failed' });
    }
  });

  router.post('/api/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  return router;
}
