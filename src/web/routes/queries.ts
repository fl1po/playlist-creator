import { Router } from 'express';
import {
  AW_BREAKDOWN,
  FILL_HISTORY,
  LISTENING_TIME,
} from '../../lib/cache-files.js';
import { createDurableCache } from '../../lib/durable-cache.js';
import type { CacheDescriptor } from '../../lib/durable-cache.js';
import { getAllUserPlaylists } from '../../lib/pagination.js';
import {
  listAiPicks,
  loadWeekAiPicks,
  readWeekPicks,
} from '../../services/ai-picks.js';
import type { RouteContext } from '../route-context.js';
import { orThrow, spotifyRoute } from '../spotify-http.js';

export function queryRoutes(ctx: RouteContext): Router {
  const router = Router();

  // Searches the trusted artists roster, not Spotify.
  router.post('/find-artist', async (req, res) => {
    const session = ctx.requireSession(req, res);
    if (!session) return;

    const query = req.body?.query?.trim();
    if (!query) {
      res.status(400).json({ error: 'query is required' });
      return;
    }

    const trusted = await ctx.loadTrustedArtistsOrRedis(session);
    if (!trusted) {
      res.status(500).json({
        error: 'trusted-artists.json not found — run recalculate first',
      });
      return;
    }

    const queryLower = query.toLowerCase();
    const artists = trusted.artistCounts;

    const rankByPriority: Record<
      number,
      Array<{ name: string; score: number }>
    > = {};
    for (const [name, data] of Object.entries(artists)) {
      if (!data.priority) continue;
      if (!rankByPriority[data.priority]) rankByPriority[data.priority] = [];
      rankByPriority[data.priority].push({ name, score: data.score });
    }
    for (const list of Object.values(rankByPriority)) {
      list.sort((a, b) => b.score - a.score);
    }

    const results = Object.entries(artists)
      .filter(([name]) => name.toLowerCase().includes(queryLower))
      .map(([name, data]) => {
        let priorityRank: number | null = null;
        let priorityGroupSize: number | null = null;
        if (data.priority && rankByPriority[data.priority]) {
          const list = rankByPriority[data.priority];
          priorityRank = list.findIndex((a) => a.name === name) + 1;
          priorityGroupSize = list.length;
        }
        return { name, data, priorityRank, priorityGroupSize };
      });

    res.json({ ok: true, results });
  });

  router.get('/artists', async (req, res) => {
    const session = ctx.requireSession(req, res);
    if (!session) return;

    const trusted = await ctx.loadTrustedArtistsOrRedis(session);
    if (!trusted) {
      res.status(500).json({ error: 'trusted-artists.json not found' });
      return;
    }

    const priorityParam = (req.query.priorities as string) ?? '1,2,3';
    const priorities = new Set(
      priorityParam.split(',').map(Number).filter(Boolean),
    );
    const sortBy = (req.query.sort as string) === 'alpha' ? 'alpha' : 'score';

    const filtered = Object.entries(trusted.artistCounts)
      .filter(
        ([, d]) => d.priority !== null && priorities.has(d.priority as number),
      )
      .sort((a, b) => {
        if (sortBy === 'alpha') return a[0].localeCompare(b[0]);
        if (a[1].priority !== b[1].priority)
          return (a[1].priority ?? 99) - (b[1].priority ?? 99);
        return b[1].score - a[1].score;
      })
      .map(([name, data]) => ({ name, ...data }));

    res.json({ ok: true, artists: filtered, stats: trusted.metadata?.stats });
  });

  router.get('/stats', async (req, res) => {
    const session = ctx.requireSession(req, res);
    if (!session) return;

    const trusted = await ctx.loadTrustedArtistsOrRedis(session);

    let overview: unknown = null;
    let scoreDistribution: unknown[] | null = null;

    if (trusted) {
      const stats = trusted.metadata?.stats;
      const artists = Object.entries(trusted.artistCounts);

      overview = {
        totalArtists: stats?.totalUniqueArtists ?? artists.length,
        p1: stats?.p1Count ?? 0,
        p2: stats?.p2Count ?? 0,
        p3: stats?.p3Count ?? 0,
        p4: stats?.p4Count ?? 0,
        lastAnalysis: trusted.metadata?.lastFullAnalysis ?? null,
        awTrackCount: trusted.metadata?.playlists?.allWeekly?.trackCount ?? 0,
        boawTrackCount:
          trusted.metadata?.playlists?.bestOfAllWeekly?.trackCount ?? 0,
      };

      const buckets = [
        { label: '100+', min: 100, max: Number.POSITIVE_INFINITY },
        { label: '76\u201399', min: 76, max: 99 },
        { label: '51\u201375', min: 51, max: 75 },
        { label: '26\u201350', min: 26, max: 50 },
        { label: '11\u201325', min: 11, max: 25 },
        { label: '1\u201310', min: 1, max: 10 },
      ];
      scoreDistribution = buckets.map((b) => ({
        label: b.label,
        count: artists.filter(([, d]) => d.score >= b.min && d.score <= b.max)
          .length,
      }));
    }

    const cache = createDurableCache({
      userId: session.userId,
      dataDir: session.dataDir,
    });
    const fillHistory = (await cache.load(FILL_HISTORY)) ?? [];

    res.json({
      ok: true,
      stats: { overview, scoreDistribution, fillHistory },
    });
  });

  router.get(
    '/user-playlists',
    spotifyRoute(async (req, res) => {
      const session = ctx.requireSession(req, res);
      if (!session) return;
      const me = orThrow(
        await session.gateway.call(
          (api) => api.currentUser.profile(),
          'user profile',
        ),
      );
      const playlists = await getAllUserPlaylists(session.gateway, me.id);
      res.json({ ok: true, playlists });
    }),
  );

  router.get(
    '/search-playlists',
    spotifyRoute(async (req, res) => {
      const session = ctx.requireSession(req, res);
      if (!session) return;

      const query = (req.query.q as string)?.trim();
      if (!query) {
        res.status(400).json({ error: 'q query parameter required' });
        return;
      }
      const result = orThrow(
        await session.gateway.call(
          (api) => api.search(query, ['playlist'], undefined, 20),
          `search playlists "${query}"`,
        ),
      );
      const playlists = (result.playlists?.items ?? [])
        .filter(Boolean)
        .map((p: any) => ({
          id: p.id,
          name: p.name,
          owner: p.owner?.display_name ?? 'Unknown',
          trackCount: p.tracks?.total ?? 0,
        }));
      res.json({ ok: true, playlists });
    }),
  );

  router.get(
    '/artist-releases',
    spotifyRoute(async (req, res) => {
      const session = ctx.requireSession(req, res);
      if (!session) return;

      const artistId = (req.query.id as string)?.trim();
      const after = (req.query.after as string) ?? '';
      const before = (req.query.before as string) ?? '';
      if (!artistId) {
        res.status(400).json({ error: 'id query parameter required' });
        return;
      }
      const result: any = orThrow(
        await session.gateway.call(
          (api) =>
            api.artists.albums(
              artistId,
              'album,single,appears_on',
              undefined,
              50,
              0,
            ),
          `artist releases ${artistId}`,
        ),
      );
      const items = (result.items ?? [])
        .filter(
          (a: any) =>
            (!after || a.release_date >= after) &&
            (!before || a.release_date <= before),
        )
        .map((a: any) => ({
          id: a.id,
          name: a.name,
          type: a.album_type,
          group: a.album_group,
          release_date: a.release_date,
          markets: a.available_markets?.length ?? 0,
        }));
      res.json({ ok: true, releases: items });
    }),
  );

  router.get(
    '/playlist-info',
    spotifyRoute(async (req, res) => {
      const session = ctx.requireSession(req, res);
      if (!session) return;

      const id = (req.query.id as string)?.trim();
      if (!id) {
        res.status(400).json({ error: 'id query parameter required' });
        return;
      }
      const pl: any = orThrow(
        await session.gateway.call(
          (api) => api.playlists.getPlaylist(id),
          `playlist info ${id}`,
        ),
      );
      res.json({
        ok: true,
        playlist: {
          id: pl.id,
          name: pl.name,
          owner: pl.owner?.display_name ?? 'Unknown',
          trackCount: pl.tracks?.total ?? 0,
        },
      });
    }),
  );

  // AI Picks card. The list reads the records alone; a week reads its
  // weekly playlist live. Neither writes a record.
  router.get('/ai-picks', async (req, res) => {
    const session = ctx.requireSession(req, res);
    if (!session) return;
    const cache = createDurableCache({
      userId: session.userId,
      dataDir: session.dataDir,
    });
    const [config, weeks] = await Promise.all([
      session.userConfigStore.load(),
      listAiPicks(cache),
    ]);
    res.json({ ok: true, enabled: config.aiFinds.enabled, weeks });
  });

  router.get(
    '/ai-picks/week',
    spotifyRoute(async (req, res) => {
      const session = ctx.requireSession(req, res);
      if (!session) return;

      const date = (req.query.date as string)?.trim();
      if (!date) {
        res.status(400).json({ error: 'date query parameter required' });
        return;
      }
      const picks = await loadWeekAiPicks(
        createDurableCache({
          userId: session.userId,
          dataDir: session.dataDir,
        }),
        date,
      );
      if (!picks) {
        res.status(404).json({ error: `No AI picks for ${date}` });
        return;
      }
      const me = orThrow(
        await session.gateway.call(
          (api) => api.currentUser.profile(),
          'user profile',
        ),
      );
      const week = await readWeekPicks(session.gateway, me.id, date, picks);
      res.json({ ok: true, ...week });
    }),
  );

  // Cached GET routes. Prefer the local file, then fall back to the durable
  // Redis copy so display stays correct on a fresh/ephemeral filesystem.
  function cachedGet(route: string, descriptor: CacheDescriptor<unknown>) {
    router.get(route, async (req, res) => {
      const session = ctx.requireSession(req, res);
      if (!session) return;
      const cached = await createDurableCache({
        userId: session.userId,
        dataDir: session.dataDir,
      }).load(descriptor);
      if (cached)
        res.json({ ok: true, ...(cached as Record<string, unknown>) });
      else res.json({ ok: false });
    });
  }
  cachedGet('/listening-time', LISTENING_TIME);
  cachedGet('/aw-breakdown', AW_BREAKDOWN);

  return router;
}
