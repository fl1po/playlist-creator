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
    if (!token) {
      res.status(400).send('<h1>Missing token</h1>');
      return;
    }
    const userId = ctx.auth.consumeAuthToken(token);
    if (!userId) {
      res.status(400).send('<h1>Invalid or expired token</h1>');
      return;
    }
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
    const { getSessionUserId } = await import('../session.js');
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

  router.post('/api/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  return router;
}
