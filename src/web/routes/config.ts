import { Router } from 'express';
import type { RouteContext } from '../route-context.js';

export function configRoutes(ctx: RouteContext): Router {
  const router = Router();

  router.get('/config', (req, res) => {
    const session = ctx.requireSession(req, res);
    if (!session) return;

    const config = session.userConfigStore.load();
    res.json({ ok: true, config, configured: session.userConfigStore.exists() });
  });

  router.put('/config', (req, res) => {
    const session = ctx.requireSession(req, res);
    if (!session) return;

    const config = req.body;
    if (!config) {
      res.status(400).json({ error: 'Config body required' });
      return;
    }

    const errors: string[] = [];
    if (!config.sourcePlaylists?.allWeeklyId)
      errors.push('All Weekly playlist ID required');
    if (!config.sourcePlaylists?.bestOfAllWeeklyId)
      errors.push('Best of All Weekly playlist ID required');

    const t = config.scoring?.priorityThresholds;
    if (t && !(t.p1 > t.p2 && t.p2 > t.p3 && t.p3 > t.p4 && t.p4 > 0)) {
      errors.push(
        'Priority thresholds must be descending (P1 > P2 > P3 > P4 > 0)',
      );
    }

    const s = config.scoring;
    if (s && (s.awWeight <= 0 || s.boawWeight <= 0)) {
      errors.push('Scoring weights must be positive');
    }

    if (errors.length > 0) {
      res.status(400).json({ error: errors.join('; ') });
      return;
    }

    session.userConfigStore.save(config);
    ctx.broadcast('log', { level: 'success', message: 'Settings saved' });
    res.json({ ok: true });
  });

  return router;
}
