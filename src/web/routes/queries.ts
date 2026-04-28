import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import {
  AW_BREAKDOWN_CACHE,
  getAllUserPlaylists,
  LISTENING_TIME_CACHE,
} from '../../lib/pagination.js';
import { createSpotifyContext } from '../../lib/spotify-context.js';
import type { RouteContext } from '../route-context.js';

export function queryRoutes(ctx: RouteContext): Router {
  const router = Router();

  // Find artist (local JSON search)
  router.post('/find-artist', (req, res) => {
    const session = ctx.requireSession(req, res);
    if (!session) return;

    const query = req.body?.query?.trim();
    if (!query) {
      res.status(400).json({ error: 'query is required' });
      return;
    }

    const trusted = ctx.loadTrustedArtists(session.dataDir);
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

  // List artists
  router.get('/artists', (req, res) => {
    const session = ctx.requireSession(req, res);
    if (!session) return;

    const trusted = ctx.loadTrustedArtists(session.dataDir);
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

  // Stats
  router.get('/stats', (req, res) => {
    const session = ctx.requireSession(req, res);
    if (!session) return;

    const trusted = ctx.loadTrustedArtists(session.dataDir);

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

    let fillHistory: unknown[] = [];
    try {
      fillHistory = JSON.parse(
        fs.readFileSync(
          path.join(session.dataDir, 'fill-history.json'),
          'utf8',
        ),
      );
    } catch {
      /* no file */
    }

    res.json({
      ok: true,
      stats: { overview, scoreDistribution, fillHistory },
    });
  });

  // User playlists
  router.get('/user-playlists', async (req, res) => {
    const session = ctx.requireSession(req, res);
    if (!session) return;

    try {
      const me = await session.client.api.currentUser.profile();
      const spotifyCtx = createSpotifyContext(
        session.client,
        undefined,
        ctx.pacer,
      );
      const playlists = await getAllUserPlaylists(spotifyCtx, me.id);
      res.json({ ok: true, playlists });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Search playlists
  router.get('/search-playlists', async (req, res) => {
    const session = ctx.requireSession(req, res);
    if (!session) return;

    const query = (req.query.q as string)?.trim();
    if (!query) {
      res.status(400).json({ error: 'q query parameter required' });
      return;
    }
    try {
      await session.client.refreshToken();
      const result = await session.client.api.search(
        query,
        ['playlist'],
        undefined,
        20,
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Artist releases
  router.get('/artist-releases', async (req, res) => {
    const session = ctx.requireSession(req, res);
    if (!session) return;

    const artistId = (req.query.id as string)?.trim();
    const after = (req.query.after as string) ?? '';
    const before = (req.query.before as string) ?? '';
    if (!artistId) {
      res.status(400).json({ error: 'id query parameter required' });
      return;
    }
    try {
      await session.client.refreshToken();
      const result: any = await session.client.api.artists.albums(
        artistId,
        'album,single,appears_on',
        undefined,
        50,
        0,
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Playlist info
  router.get('/playlist-info', async (req, res) => {
    const session = ctx.requireSession(req, res);
    if (!session) return;

    const id = (req.query.id as string)?.trim();
    if (!id) {
      res.status(400).json({ error: 'id query parameter required' });
      return;
    }
    try {
      await session.client.refreshToken();
      const pl: any = await session.client.api.playlists.getPlaylist(id);
      res.json({
        ok: true,
        playlist: {
          id: pl.id,
          name: pl.name,
          owner: pl.owner?.display_name ?? 'Unknown',
          trackCount: pl.tracks?.total ?? 0,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Cached GET routes
  function cachedGet(route: string, cacheFile: string) {
    router.get(route, (req, res) => {
      const session = ctx.requireSession(req, res);
      if (!session) return;
      try {
        const cached = JSON.parse(fs.readFileSync(path.join(session.dataDir, cacheFile), 'utf8'));
        res.json({ ok: true, ...cached });
      } catch {
        res.json({ ok: false });
      }
    });
  }
  cachedGet('/listening-time', LISTENING_TIME_CACHE);
  cachedGet('/aw-breakdown', AW_BREAKDOWN_CACHE);

  return router;
}
