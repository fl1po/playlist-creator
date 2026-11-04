import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import { createAppConfigStore } from '../lib/config.js';
import { playlistReads } from '../lib/playlist-reads/index.js';
import { createCallStats } from '../lib/spotify/call-stats.js';
import { RequestPacer, type SessionGateway } from '../lib/spotify/gateway.js';
import {
  UpstashRedisPort,
  type UserData,
  upstashFromEnv,
} from '../lib/user-data/index.js';
import { createAuthManager } from './auth.js';
import { bearerIdentity } from './bearer-identity.js';
import { createBroadcaster, type DeployInfo } from './broadcast.js';
import { upstashLogStore } from './log-store.js';
import { createRouteContext } from './route-context.js';
import { authRoutes } from './routes/auth.js';
import { configRoutes } from './routes/config.js';
import { queryRoutes } from './routes/queries.js';
import {
  createStreamTicket,
  getSessionUserId,
  verifyStreamTicket,
} from './session.js';
import { orThrow, spotifyRoute } from './spotify-http.js';
import {
  createTaskRunner,
  mountTask,
  mountTaskControls,
  type TaskDefinition,
} from './task-runner.js';
import { awBreakdownTask } from './tasks/aw-breakdown.js';
import { clearTask } from './tasks/clear.js';
import { dedupRemoveTask } from './tasks/dedup-remove.js';
import { dedupScanTask } from './tasks/dedup-scan.js';
import { fillTask } from './tasks/fill.js';
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
// The one Redis client, read from the env here and nowhere else (ADR-0008).
// Without it, every user's data and the live log stay on this machine.
const upstash = upstashFromEnv();
// The live log persists in Redis for a week, so it survives deploys.
const broadcaster = createBroadcaster({
  store: upstash ? upstashLogStore(upstash) : null,
});
const broadcast = broadcaster.broadcast;

const LOG_FLUSH_MS = 10_000;
setInterval(() => void broadcaster.flush(), LOG_FLUSH_MS).unref();
// A deploy stops the old process with SIGTERM: store what's left first.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void broadcaster.flush().finally(() => process.exit(0));
  });
}

// Every user's Spotify calls, summarised into their log and stdout, so a
// rate limit can be traced to what spent it.
const CALL_REPORT_MINUTES = 5;
const callStats = createCallStats({
  windowMinutes: CALL_REPORT_MINUTES,
  report: (userId, { level, message }) => {
    console.log(`[spotify] ${userId}: ${message}`);
    broadcaster.broadcastTo(userId, 'log', { level, message }, 'spotify');
  },
});
setInterval(() => callStats.report(), CALL_REPORT_MINUTES * 60 * 1000).unref();

// Server-wide: one task runs at a time across all users (ADR-0003).
const taskRunner = createTaskRunner({ broadcaster });

// ── Route Context ───────────────────────────────────────────────────────────

const auth = createAuthManager({
  loadAppConfig: () => appConfigStore.load(),
  getOrCreateUserSession: (userId, appConfig) =>
    ctx.getOrCreateUserSession(userId, appConfig),
  getUserDataDir: (userId) => ctx.getUserDataDir(userId),
  broadcast,
  broadcastTo: broadcaster.broadcastTo,
  mainPort: PORT,
});

const ctx = createRouteContext({
  broadcaster,
  pacer,
  callStats,
  appConfigStore,
  auth,
  usersDir: USERS_DIR,
  projectRoot: PROJECT_ROOT,
  port: PORT,
  redis: upstash ? new UpstashRedisPort(upstash) : null,
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

// Auth routes handle raw tokens themselves; everything else under /api must
// prove a Bearer token belongs to the X-User-Id it claims.
const verifyBearer = bearerIdentity({
  loadAppConfig: () => appConfigStore.load(),
  onTokensRefreshed: (userId, tokens) =>
    broadcaster.broadcastTo(userId, 'data:save', {
      key: 'tokens',
      value: tokens,
    }),
});
app.use('/api', (req, res, next) =>
  req.path.startsWith('/auth') ? next() : verifyBearer(req, res, next),
);

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  // Identify the user from a signed ticket (Bearer mode — EventSource can't
  // send headers) or the session cookie. Never from an unsigned id: the
  // stream carries that user's logs and refreshed tokens.
  let userId: string | null = null;
  try {
    const { clientSecret } = appConfigStore.load();
    const ticket = req.query.ticket;
    userId =
      typeof ticket === 'string'
        ? verifyStreamTicket(ticket, clientSecret)
        : getSessionUserId(req, clientSecret);
  } catch {
    /* no config */
  }
  // EventSource sends Last-Event-ID only when it reconnects by itself; a
  // fresh page passes the position it cached as `since` instead.
  const since = typeof req.query.since === 'string' ? req.query.since : null;
  broadcaster.addClient(
    res,
    userId,
    (req.headers['last-event-id'] as string | undefined) ?? since,
  );
  // Comment frames keep idle proxies (Railway drops at ~5min) from killing the
  // stream, which otherwise reconnects endlessly during quiet periods.
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 25_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    broadcaster.removeClient(res);
  });
});

app.get('/api/events/ticket', (req, res) => {
  const session = ctx.requireSession(req, res);
  if (!session) return;
  res.json({
    ticket: createStreamTicket(
      session.userId,
      ctx.loadAppConfig().clientSecret,
    ),
  });
});

// ── Mount route modules ─────────────────────────────────────────────────────

app.use(authRoutes(ctx));
app.use('/api', queryRoutes(ctx));
app.use('/api', configRoutes(ctx));

// ── Register tasks ──────────────────────────────────────────────────────────

for (const task of [
  fillTask,
  recalculateTask,
  dedupScanTask,
  dedupRemoveTask,
  listeningTimeTask,
  awBreakdownTask,
  clearTask,
] as TaskDefinition[]) {
  mountTask(app, taskRunner, task, ctx.requireSession);
}
mountTaskControls(app, taskRunner, ctx.requireSession);

// ── Simple inline routes ────────────────────────────────────────────────────

app.post('/api/clear-logs', async (req, res) => {
  const session = ctx.requireSession(req, res);
  if (!session) return;
  try {
    await broadcaster.clearHistory(session.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// The last week of the log as text, one line per log message: the same
// lines the panel shows (ADR-0007). Task results are data and are left out.
app.get('/api/logs/export', async (req, res) => {
  const session = ctx.requireSession(req, res);
  if (!session) return;
  try {
    const lines = (await broadcaster.week(session.userId)).map((m) => {
      const when = new Date(m.ts).toISOString();
      const task = m.task ? ` [${m.task}]` : '';
      if (m.type === 'log') {
        const d = m.data as { level?: string; message?: string } | string;
        return typeof d === 'string'
          ? `${when}${task} ${d}`
          : `${when}${task} ${d.level ?? 'info'}: ${d.message}`;
      }
      if (m.type === 'server:restarted') {
        return `${when} server restarted ${JSON.stringify(m.data)}`;
      }
      return null;
    });
    res
      .type('text/plain')
      .attachment(`log-${session.userId}.txt`)
      .send(`${lines.filter((l) => l !== null).join('\n')}\n`);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// The session user's Spotify calls since this process started.
app.get('/api/debug/spotify-calls', (req, res) => {
  const session = ctx.requireSession(req, res);
  if (!session) return;
  res.json({
    since: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    ...callStats.totals(session.userId),
  });
});

// ── Playback tracking ──────────────────────────────────────────────────────

/**
 * The playlist a user is playing, as the playback poll last saw it. The
 * tracks themselves live in playlist reads (ADR-0011); this holds only the
 * last answer and the throttles, for one playlist per user.
 */
interface PlayingPlaylist {
  playlistId: string;
  name?: string;
  /** The live snapshot, as of `checkedAt`. */
  snapshot?: string;
  checkedAt: number;
  /** The last loaded tracks (possibly of an older snapshot) and their snapshot. */
  tracks?: Array<{ id: string; durationMs: number }>;
  totalMs?: number;
  tracksSnapshot?: string;
  loadStartedAt: number;
}

const playingByUser = new Map<string, PlayingPlaylist>();
/** Check the playing playlist's snapshot, or retry a load, at most this often. */
const SNAPSHOT_CHECK_INTERVAL_MS = 60_000;

function playingPlaylist(userId: string, playlistId: string): PlayingPlaylist {
  let playing = playingByUser.get(userId);
  if (playing?.playlistId !== playlistId) {
    playing = { playlistId, checkedAt: 0, loadStartedAt: 0 };
    playingByUser.set(userId, playing);
  }
  return playing;
}

/**
 * Load the playing playlist's tracks in the background: the poll answers with
 * whatever it has and a later poll picks the load up. Nothing waits on the
 * load, so it runs on the background lane and takes turns with a running
 * task's calls. A failed load isn't retried before the check interval, or
 * every poll during an outage would start another.
 */
function loadPlayingTracks(
  session: { gateway: SessionGateway; data: UserData },
  playing: PlayingPlaylist,
) {
  const snapshot = playing.snapshot;
  if (!snapshot) return;
  if (Date.now() - playing.loadStartedAt < SNAPSHOT_CHECK_INTERVAL_MS) return;
  playing.loadStartedAt = Date.now();
  const background = session.gateway.forTask({
    signal: new AbortController().signal,
  });
  playlistReads({ gateway: background, data: session.data })
    .tracks(playing.playlistId, { snapshot })
    .then((read) => {
      if (!read.success) return;
      const tracks = read.items.flatMap(({ track }) =>
        track ? [{ id: track.id, durationMs: track.durationMs }] : [],
      );
      playing.tracks = tracks;
      playing.totalMs = tracks.reduce((sum, t) => sum + t.durationMs, 0);
      playing.tracksSnapshot = snapshot;
    })
    // Auth loss surfaces on the next poll's own calls.
    .catch(() => {});
}

function computeRemaining(
  tracks: Array<{ id: string; durationMs: number }>,
  trackId: string,
  progressMs: number,
  durationMs: number,
): { ms: number; tracks: number } | null {
  const idx = tracks.findIndex((t) => t.id === trackId);
  if (idx < 0) return null;
  let afterMs = 0;
  for (let i = idx + 1; i < tracks.length; i++) {
    afterMs += tracks[i].durationMs;
  }
  return {
    ms: durationMs - progressMs + afterMs,
    tracks: tracks.length - idx - 1,
  };
}

app.get(
  '/api/playback',
  spotifyRoute(async (req, res) => {
    const session = ctx.requireSession(req, res);
    if (!session) return;
    const { gateway } = session;

    const playback = orThrow(
      await gateway.call(
        (api) => api.player.getPlaybackState(),
        'playback state',
      ),
    );

    if (!(playback?.item && 'album' in playback.item)) {
      res.json({ playing: false });
      return;
    }

    const item = playback.item;
    const progressMs = playback.progress_ms ?? 0;

    // Split track artists into primary vs featured. An album can have multiple
    // primary artists, so treat any track artist that's also credited on the
    // album as primary, and the rest as featured. Fall back to the first artist
    // when the album credit doesn't overlap (e.g. compilations / "Various
    // Artists"), which mirrors the index-0 convention used in scoring.
    const albumArtistIds = new Set((item.album.artists ?? []).map((a) => a.id));
    let primaryArtists = item.artists.filter((a) => albumArtistIds.has(a.id));
    if (primaryArtists.length === 0 && item.artists.length > 0) {
      primaryArtists = [item.artists[0]];
    }
    const primaryIds = new Set(primaryArtists.map((a) => a.id));
    const featuredArtists = item.artists.filter((a) => !primaryIds.has(a.id));

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
        const playing = playingPlaylist(session.userId, ctxId);
        // Spotify's snapshot_id changes on any edit, so a cheap fetch of it
        // (and the name) says whether the tracks held are stale. This poll
        // runs every few seconds, so the check is throttled per playlist.
        if (Date.now() - playing.checkedAt >= SNAPSHOT_CHECK_INTERVAL_MS) {
          const head = await gateway.call(
            (api) =>
              api.playlists.getPlaylist(ctxId, undefined, 'snapshot_id,name'),
            `playlist snapshot ${ctxId}`,
          );
          // On failure, answer with what's held and check again next poll.
          if (head.success) {
            playing.snapshot = head.data.snapshot_id;
            playing.name = head.data.name;
            playing.checkedAt = Date.now();
          }
        }
        // Until the load lands, a stale list is a better answer than none.
        if (playing.tracksSnapshot !== playing.snapshot)
          loadPlayingTracks(session, playing);
        if (playing.tracks) {
          contextInfo.name = playing.name;
          contextInfo.totalTracks = playing.tracks.length;
          contextInfo.totalMs = playing.totalMs;
          remaining = computeRemaining(
            playing.tracks,
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
        primaryArtists: primaryArtists.map((a) => a.name),
        featured: featuredArtists.map((a) => a.name),
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
  }),
);

app.get(
  '/api/album/:id',
  spotifyRoute(async (req, res) => {
    const session = ctx.requireSession(req, res);
    if (!session) return;
    const { gateway } = session;
    const albumId = req.params.id as string;

    const album = orThrow(
      await gateway.call((api) => api.albums.get(albumId), `album ${albumId}`),
    );
    // Same primary/featured split as /api/playback.
    const albumArtistIds = new Set((album.artists ?? []).map((a) => a.id));
    const mapTrack = (t: (typeof album.tracks.items)[number]) => {
      let primary = t.artists.filter((a) => albumArtistIds.has(a.id));
      if (primary.length === 0 && t.artists.length > 0) {
        primary = [t.artists[0]];
      }
      const primaryIds = new Set(primary.map((a) => a.id));
      const featured = t.artists.filter((a) => !primaryIds.has(a.id));
      return {
        id: t.id,
        name: t.name,
        track_number: t.track_number,
        duration_ms: t.duration_ms,
        artists: t.artists.map((a) => a.name).join(', '),
        primaryArtists: primary.map((a) => a.name),
        featured: featured.map((a) => a.name),
      };
    };
    const tracks = album.tracks.items.map(mapTrack);

    let offset = album.tracks.items.length;
    while (offset < album.tracks.total) {
      const page = orThrow(
        await gateway.call(
          (api) => api.albums.tracks(albumId, undefined, 50, offset),
          `album tracks ${albumId}`,
        ),
      );
      if (page.items.length === 0) break;
      tracks.push(...page.items.map(mapTrack));
      offset += page.items.length;
    }

    const trackIds = tracks.map((t) => t.id).filter(Boolean);
    const batches: Promise<{
      ids: string[];
      pop: any[];
      liked: boolean[];
    }>[] = [];
    for (let i = 0; i < trackIds.length; i += 50) {
      const ids = trackIds.slice(i, i + 50);
      batches.push(
        Promise.all([
          gateway.call((api) => api.tracks.get(ids), 'track popularity'),
          gateway.call(
            (api) => api.currentUser.tracks.hasSavedTracks(ids),
            'saved tracks',
          ),
        ]).then(([pop, liked]) => ({
          ids,
          pop: orThrow(pop),
          liked: orThrow(liked),
        })),
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
  }),
);

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

/** The deploy Railway built this process from; empty when run elsewhere. */
function deployInfo(): DeployInfo {
  const env = process.env;
  return {
    commit: env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7),
    // Just the subject line.
    message: env.RAILWAY_GIT_COMMIT_MESSAGE?.split('\n')[0].trim(),
    branch: env.RAILWAY_GIT_BRANCH,
  };
}

const deploy = deployInfo();
if (deploy.commit) {
  console.log(
    `Deployed ${deploy.commit} "${deploy.message ?? ''}" (${deploy.branch ?? '?'})`,
  );
}

broadcaster
  .restore(deploy)
  .catch((err) => {
    console.error('Restoring the log failed:', err);
  })
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Dashboard running at http://localhost:${PORT}`);
    });
  });
