import { Router } from 'express';
import type { RouteContext } from '../route-context.js';

export function configRoutes(ctx: RouteContext): Router {
  const router = Router();

  router.get('/config', async (req, res) => {
    const session = ctx.requireSession(req, res);
    if (!session) return;

    const [config, configured] = await Promise.all([
      session.userConfigStore.load(),
      session.userConfigStore.exists(),
    ]);
    res.json({ ok: true, config, configured });
  });

  router.put('/config', async (req, res) => {
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
    if (
      !config.sourcePlaylists?.useLikedSongs &&
      !config.sourcePlaylists?.bestOfAllWeeklyId
    )
      errors.push(
        'Best of All Weekly playlist ID required (or enable Liked Songs)',
      );

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
    if (
      s &&
      s.featuredMultiplier != null &&
      (s.featuredMultiplier < 0 || s.featuredMultiplier > 1)
    ) {
      errors.push('Featured multiplier must be between 0 and 1');
    }

    if (errors.length > 0) {
      res.status(400).json({ error: errors.join('; ') });
      return;
    }

    // No log broadcast here: this endpoint also backs implicit writes (the
    // listening-budget input, config migration). Only an explicit Save in the
    // settings modal logs, and the client does that itself.
    await session.userConfigStore.save(config);
    res.json({ ok: true });
  });

  return router;
}
