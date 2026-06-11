import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import compression from 'compression';
import express from 'express';
import { UserTokenStore, createAppConfigStore } from '../lib/config.js';
import { RequestPacer } from '../lib/request-pacer.js';
import { broadcastEvents } from '../lib/service-events.js';
import { createSpotifyContext } from '../lib/spotify-context.js';
import type { AppConfig } from '../lib/types.js';
import {
  type PlaylistClearerEventMap,
  PlaylistClearerService,
} from '../services/playlist-clearer.js';
import { createAuthManager, fetchSpotifyUserId } from './auth.js';
import { createBroadcaster } from './broadcast.js';
import { createRouteContext } from './route-context.js';
import { authRoutes } from './routes/auth.js';
import { configRoutes } from './routes/config.js';
import { queryRoutes } from './routes/queries.js';
import { getSessionUserId } from './session.js';
import { createTaskMutex } from './task-mutex.js';
import { createTaskRunner } from './task-runner.js';
import { awBreakdownTask } from './tasks/aw-breakdown.js';
import { dedupRemoveTask } from './tasks/dedup-remove.js';
import { dedupScanTask } from './tasks/dedup-scan.js';
import { fillTask, getSearchedArtists } from './tasks/fill.js';
import { listeningTimeTask } from './tasks/listening-time.js';
import { recalculateTask } from './tasks/recalculate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const PORT = Number(process.env.PORT ?? 3005);

// ── Shared singletons ──────────────────────────────────────────────────────

const pacer = new RequestPacer(1);
const appConfigStore = createAppConfigStore();
const broadcaster = createBroadcaster();
const broadcast = broadcaster.broadcast;

const taskMutex = createTaskMutex((busy, task) => {
  broadcast('status', { busy, task });
});

// ── Route Context ───────────────────────────────────────────────────────────

const auth = createAuthManager({
  loadAppConfig: () => appConfigStore.load(),
  getOrCreateUserSession: (userId, appConfig) =>
    ctx.getOrCreateUserSession(userId, appConfig),
  getUserDataDir: (userId) => ctx.getUserDataDir(userId),
  broadcast,
  mainPort: PORT,
});

const ctx = createRouteContext({
  broadcaster,
  taskMutex,
  pacer,
  appConfigStore,
  auth,
  usersDir: USERS_DIR,
  projectRoot: PROJECT_ROOT,
  port: PORT,
});

// ── Express + SSE ───────────────────────────────────────────────────────────

const app = express();
app.use(
  compression({
    filter: (req) => !req.url.startsWith('/api/events'),
  }),
);
app.use(express.json({ limit: '5mb' }));
const publicDir = fs.existsSync(path.join(__dirname, '../../src/web/public'))
  ? path.join(__dirname, '../../src/web/public')
  : path.join(__dirname, 'public');
app.use(express.static(publicDir));

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  // Identify user from header, query param, or cookie
  let userId: string | null = (req.headers['x-user-id'] as string) ?? null;
  if (!userId) userId = (req.query.userId as string) ?? null;
  if (!userId) {
    try {
      const appConfig = appConfigStore.load();
      userId = getSessionUserId(req, appConfig.clientSecret);
    } catch {
      /* no config */
    }
  }
  broadcaster.addClient(
    res,
    userId,
    taskMutex.currentTask,
    getSearchedArtists(),
  );
  req.on('close', () => broadcaster.removeClient(res));
});

// ── Mount route modules ─────────────────────────────────────────────────────

app.use(authRoutes(ctx));
app.use('/api', queryRoutes(ctx));
app.use('/api', configRoutes(ctx));

// ── Register tasks ──────────────────────────────────────────────────────────

const taskRunner = createTaskRunner({ app, routeCtx: ctx });
taskRunner.register(fillTask);
taskRunner.register(recalculateTask);
taskRunner.register(dedupScanTask);
taskRunner.register(dedupRemoveTask);
taskRunner.register(listeningTimeTask);
taskRunner.register(awBreakdownTask);

// ── Simple inline routes ────────────────────────────────────────────────────

// Export all user data for localStorage migration
app.get('/api/export-data', async (req, res) => {
  const session = ctx.requireSession(req, res);
  if (!session) return;

  const read = (file: string) => {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(session.dataDir, file), 'utf8'),
      );
    } catch {
      return null;
    }
  };

  // Read config from file directly (store may return defaults if file missing)
  const config =
    read('user-config.json') ?? (await session.userConfigStore.load());

  res.json({
    ok: true,
    config,
    trustedArtists: read('trusted-artists.json'),
    batchCache: read('batch-cache.json'),
    fillHistory: read('fill-history.json'),
    durationSnapshots: read('duration-snapshots.json'),
    listeningTime: read('listening-time-cache.json'),
    awBreakdown: read('aw-breakdown.json'),
  });
});

// Import data (for migrating from local to production)
app.post('/api/import-data', async (req, res) => {
  const session = ctx.requireSession(req, res);
  if (!session) return;

  const {
    config,
    trustedArtists,
    batchCache,
    fillHistory,
    durationSnapshots,
    listeningTime,
    awBreakdown,
  } = req.body;

  // Save config to the config store (Redis in production)
  let configSaved = false;
  if (config) {
    try {
      await session.userConfigStore.save(config);
      configSaved = true;
    } catch (err) {
      console.error('Failed to save config:', err);
    }
  }

  // Save trustedArtists + fillHistory to Redis for cross-device access
  if (trustedArtists || fillHistory) {
    try {
      const { redisSaveTrustedArtists, redisSaveFillHistory } = await import(
        './redis-config-store.js'
      );
      if (trustedArtists)
        await redisSaveTrustedArtists(session.userId, trustedArtists);
      if (fillHistory) await redisSaveFillHistory(session.userId, fillHistory);
    } catch (err) {
      console.error('Failed to save to Redis:', err);
    }
  }

  // Return caches AND config — the client will save to localStorage
  const caches: Record<string, unknown> = {};
  if (trustedArtists) caches.trustedArtists = trustedArtists;
  if (batchCache) caches.batchCache = batchCache;
  if (fillHistory) caches.fillHistory = fillHistory;
  if (durationSnapshots) caches.durationSnapshots = durationSnapshots;
  if (listeningTime) caches.listeningTime = listeningTime;
  if (awBreakdown) caches.awBreakdown = awBreakdown;

  res.json({
    ok: true,
    configSaved,
    configReceived: !!config,
    caches,
    config: config || null,
  });
});

// Clear playlist (synchronous — no mutex)
app.post('/api/clear', async (req, res) => {
  const session = ctx.requireSession(req, res);
  if (!session) return;

  const name = req.body?.name?.trim();
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const userBroadcast = (type: string, data: unknown) =>
    broadcaster.broadcastTo(session.userId, type, data);

  userBroadcast('log', {
    level: 'info',
    message: `Clearing playlist "${name}"...`,
  });

  const spotifyCtx = createSpotifyContext(session.client, undefined, pacer);
  const service = new PlaylistClearerService(
    spotifyCtx,
    broadcastEvents<PlaylistClearerEventMap>(userBroadcast, {
      playlistFound: {
        log: (n, count) => `Found "${n}" (${count} tracks)`,
      },
      playlistNotFound: {
        log: (n) => `Playlist "${n}" not found`,
        level: 'warn',
      },
      cleared: {
        type: 'clear:complete',
        pack: (n, count) => ({ name: n, cleared: count }),
      },
    }),
  );

  try {
    const result = await service.clear(name);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/stop', (_req, res) => {
  if (!taskMutex.currentTask) {
    res.status(400).json({ error: 'No task running' });
    return;
  }
  if (taskMutex.stop()) {
    broadcast('log', {
      level: 'warn',
      message: `Stopping ${taskMutex.currentTask}...`,
    });
    res.json({ ok: true, message: `Stopping ${taskMutex.currentTask}` });
  } else {
    res.json({ ok: true, message: 'Already stopping' });
  }
});

app.post('/api/clear-logs', (_req, res) => {
  broadcaster.clearHistory();
  res.json({ ok: true });
});

app.get('/api/status', (_req, res) => {
  res.json({ busy: !!taskMutex.currentTask, task: taskMutex.currentTask });
});

// ── Playback tracking ──────────────────────────────────────────────────────

interface PlaylistCache {
  name: string;
  tracks: Array<{ id: string; duration_ms: number }>;
  totalMs: number;
}

const PLAYLIST_CACHE_MAX = 50;
const playlistDurationCache = new Map<string, PlaylistCache>();

function cachePlaylist(id: string, entry: PlaylistCache) {
  if (playlistDurationCache.size >= PLAYLIST_CACHE_MAX) {
    const oldest = playlistDurationCache.keys().next().value;
    if (oldest) playlistDurationCache.delete(oldest);
  }
  playlistDurationCache.set(id, entry);
}

async function loadPlaylistCache(
  spotifyApi: SpotifyApi,
  playlistId: string,
): Promise<PlaylistCache | null> {
  try {
    const meta = await spotifyApi.playlists.getPlaylist(playlistId);
    const tracks: Array<{ id: string; duration_ms: number }> = [];
    let totalMs = 0;
    let offset = 0;
    const limit = 50;
    while (true) {
      const page = await spotifyApi.playlists.getPlaylistItems(
        playlistId,
        undefined,
        undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        limit as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        offset as any,
      );
      for (const item of page.items) {
        const t = item.track;
        if (t && 'duration_ms' in t) {
          tracks.push({ id: t.id, duration_ms: t.duration_ms });
          totalMs += t.duration_ms;
        }
      }
      if (offset + page.items.length >= page.total) break;
      offset += page.items.length;
    }
    return { name: meta.name, tracks, totalMs };
  } catch {
    return null;
  }
}

function computeRemaining(
  cached: PlaylistCache,
  trackId: string,
  progressMs: number,
  durationMs: number,
): { ms: number; tracks: number } | null {
  const idx = cached.tracks.findIndex((t) => t.id === trackId);
  if (idx < 0) return null;
  let afterMs = 0;
  for (let i = idx + 1; i < cached.tracks.length; i++) {
    afterMs += cached.tracks[i].duration_ms;
  }
  return {
    ms: durationMs - progressMs + afterMs,
    tracks: cached.tracks.length - idx - 1,
  };
}

app.get('/api/playback', async (req, res) => {
  const session = ctx.requireSession(req, res);
  if (!session) return;

  try {
    const spotifyApi = session.client.api;
    const playback = await spotifyApi.player.getPlaybackState();

    if (!playback?.item || !('album' in playback.item)) {
      res.json({ playing: false });
      return;
    }

    const item = playback.item;
    const progressMs = playback.progress_ms ?? 0;

    let contextInfo: {
      type: 'playlist' | 'album';
      id: string;
      name?: string;
      totalTracks?: number;
      totalMs?: number;
    } | null = null;
    let remaining: { ms: number; tracks: number } | null = null;

    const ctxUri = playback.context?.uri;
    if (ctxUri) {
      const [, ctxType, ctxId] = ctxUri.split(':');
      if (ctxType === 'playlist' && ctxId) {
        contextInfo = { type: 'playlist', id: ctxId };
        let cached = playlistDurationCache.get(ctxId);
        if (!cached) {
          const loaded = await loadPlaylistCache(spotifyApi, ctxId);
          if (loaded) {
            cached = loaded;
            cachePlaylist(ctxId, loaded);
          }
        }
        if (cached) {
          contextInfo.name = cached.name;
          contextInfo.totalTracks = cached.tracks.length;
          contextInfo.totalMs = cached.totalMs;
          remaining = computeRemaining(
            cached,
            item.id,
            progressMs,
            item.duration_ms,
          );
        }
      } else if (ctxType === 'album' && ctxId) {
        contextInfo = { type: 'album', id: ctxId };
      }
    }

    const images = item.album.images ?? [];
    // Spotify returns images largest-first; pick smallest ≥64px for the bar thumbnail.
    const albumArt =
      [...images].reverse().find((img) => (img.width ?? 0) >= 64)?.url ??
      images[0]?.url ??
      null;
    // Largest image for the album detail modal.
    const albumArtLarge = images[0]?.url ?? null;

    res.json({
      playing: true,
      isPlaying: playback.is_playing,
      track: {
        id: item.id,
        name: item.name,
        artists: item.artists.map((a) => a.name).join(', '),
        album: item.album.name,
        album_id: item.album.id,
        albumArt,
        albumArtLarge,
        duration_ms: item.duration_ms,
        track_number: item.track_number ?? null,
        album_total_tracks: item.album.total_tracks ?? null,
      },
      progress_ms: progressMs,
      device: playback.device?.name ?? null,
      shuffle: playback.shuffle_state ?? false,
      repeat: playback.repeat_state ?? 'off',
      context: contextInfo,
      remaining,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get('/api/album/:id', async (req, res) => {
  const session = ctx.requireSession(req, res);
  if (!session) return;

  try {
    const album = await session.client.api.albums.get(req.params.id);
    const mapTrack = (t: (typeof album.tracks.items)[number]) => ({
      id: t.id,
      name: t.name,
      track_number: t.track_number,
      duration_ms: t.duration_ms,
      artists: t.artists.map((a) => a.name).join(', '),
    });
    const tracks = album.tracks.items.map(mapTrack);

    let offset = album.tracks.items.length;
    while (offset < album.tracks.total) {
      const page = await session.client.api.albums.tracks(
        req.params.id,
        undefined,
        50,
        offset,
      );
      if (page.items.length === 0) break;
      tracks.push(...page.items.map(mapTrack));
      offset += page.items.length;
    }

    const trackIds = tracks.map((t) => t.id).filter(Boolean);
    const batches: Promise<{ ids: string[]; pop: any[]; liked: boolean[] }>[] =
      [];
    for (let i = 0; i < trackIds.length; i += 50) {
      const ids = trackIds.slice(i, i + 50);
      batches.push(
        Promise.all([
          session.client.api.tracks.get(ids),
          session.client.api.currentUser.tracks.hasSavedTracks(ids),
        ]).then(([pop, liked]) => ({ ids, pop, liked })),
      );
    }
    const results = await Promise.all(batches);

    const popularityMap = new Map<string, number>();
    const likedSet = new Set<string>();
    for (const { ids, pop, liked } of results) {
      for (const ft of pop) {
        if (ft) popularityMap.set(ft.id, ft.popularity);
      }
      ids.forEach((id, i) => {
        if (liked[i]) likedSet.add(id);
      });
    }

    const tracksWithPop = tracks.map((t) => ({
      ...t,
      popularity: popularityMap.get(t.id) ?? 0,
      liked: likedSet.has(t.id),
    }));

    const images = album.images ?? [];
    const coverArt = images[0]?.url ?? null;

    res.json({
      id: album.id,
      name: album.name,
      artists: album.artists.map((a) => a.name).join(', '),
      release_date: album.release_date,
      total_tracks: album.total_tracks,
      coverArt,
      tracks: tracksWithPop,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── Migration ───────────────────────────────────────────────────────────────

async function migrateFromLegacy() {
  // Skip migration when running with env-based config (production)
  if (process.env.SPOTIFY_CLIENT_ID) return;
  if (appConfigStore.exists()) return;

  const legacyPath = path.join(PROJECT_ROOT, 'spotify-config.json');
  if (!fs.existsSync(legacyPath)) return;

  console.log('Migrating from legacy single-user config...');

  try {
    const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));

    const appConfig: AppConfig = {
      clientId: legacy.clientId,
      clientSecret: legacy.clientSecret,
      redirectUri: legacy.redirectUri,
    };
    (appConfigStore as import('../lib/config.js').AppConfigStore).save(
      appConfig,
    );
    console.log('  Created data/app-config.json');

    const envUserId = process.env.SPOTIFY_USER_ID;
    if (legacy.accessToken && legacy.refreshToken) {
      let userId: string | null = null;
      let displayName: string | null = null;

      try {
        const user = await fetchSpotifyUserId(legacy.accessToken);
        userId = user.id;
        displayName = user.displayName;
      } catch {
        try {
          const authHeader = `Basic ${Buffer.from(`${appConfig.clientId}:${appConfig.clientSecret}`).toString('base64')}`;
          const params = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: legacy.refreshToken,
          });
          const tokenRes = await fetch(
            'https://accounts.spotify.com/api/token',
            {
              method: 'POST',
              headers: {
                Authorization: authHeader,
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: params,
            },
          );
          if (tokenRes.ok) {
            const data = (await tokenRes.json()) as {
              access_token: string;
              refresh_token?: string;
            };
            legacy.accessToken = data.access_token;
            if (data.refresh_token) legacy.refreshToken = data.refresh_token;
            const user = await fetchSpotifyUserId(data.access_token);
            userId = user.id;
            displayName = user.displayName;
            console.log('  Refreshed expired token for migration');
          } else {
            throw new Error('Refresh failed');
          }
        } catch {
          if (envUserId) {
            userId = envUserId;
            console.log(
              `  Token expired — using SPOTIFY_USER_ID="${envUserId}" for migration`,
            );
          } else {
            console.log(
              `  Warning: Could not fetch userId (token expired) and SPOTIFY_USER_ID not set.`,
            );
            console.log(
              `  Re-run with: SPOTIFY_USER_ID=<your-spotify-id> npm run dashboard`,
            );
            console.log(
              `  Find your ID: Spotify profile > ... > Share > Copy link (ID is in the URL)`,
            );
          }
        }
      }

      if (userId) {
        const userDir = ctx.getUserDataDir(userId);
        fs.mkdirSync(userDir, { recursive: true });

        const tokenStore = new UserTokenStore(userId, userDir);
        tokenStore.save({
          accessToken: legacy.accessToken,
          refreshToken: legacy.refreshToken,
        });
        console.log(
          `  Migrated tokens for user: ${displayName ?? userId} (${userId})`,
        );

        const filesToCopy = [
          { from: 'user-config.json', to: 'user-config.json' },
          { from: 'trusted-artists.json', to: 'trusted-artists.json' },
          { from: 'batch-cache.json', to: 'batch-cache.json' },
          { from: 'batch-p1p2-progress.json', to: 'batch-p1p2-progress.json' },
        ];

        for (const { from, to } of filesToCopy) {
          const srcPath = path.join(PROJECT_ROOT, from);
          if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, path.join(userDir, to));
            console.log(`  Copied ${from} -> data/users/${userId}/${to}`);
          }
        }
      }
    }

    console.log('Migration complete. Legacy files left in place as backup.');
  } catch (err) {
    console.error('Migration failed:', err);
  }
}

// ── Dev: watch public dir for frontend hot reload ───────────────────────────

const srcPublic = path.join(__dirname, '../../src/web/public');
if (fs.existsSync(srcPublic)) {
  let debounce: ReturnType<typeof setTimeout> | null = null;
  fs.watch(srcPublic, { recursive: true }, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => broadcast('reload', {}), 100);
  });
}

// ── Start ───────────────────────────────────────────────────────────────────

migrateFromLegacy().then(() => {
  app.listen(PORT, () => {
    console.log(`Dashboard running at http://localhost:${PORT}`);
  });
});
