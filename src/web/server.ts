import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { filterByPriority } from '../domain/artists.js';
import {
  AppConfigStore,
  BridgedConfigStore,
  UserTokenStore,
} from '../lib/config.js';
import {
  getAllPlaylistTracks,
  getAllUserPlaylists,
  getPlaylistTracksDetailed,
} from '../lib/pagination.js';
import { RequestPacer } from '../lib/request-pacer.js';
import { createSpotifyClient } from '../lib/spotify-client.js';
import { createSpotifyContext } from '../lib/spotify-context.js';
import type {
  AppConfig,
  SpotifyClient,
  TrustedArtistsFile,
} from '../lib/types.js';
import { UserConfigStore } from '../lib/user-config.js';
import {
  PlaylistClearerService,
  type PlaylistClearerEventMap,
} from '../services/playlist-clearer.js';
import {
  PlaylistFillerService,
  type PlaylistFillerEventMap,
} from '../services/playlist-filler.js';
import {
  PriorityCalculatorService,
  type PriorityCalculatorEventMap,
} from '../services/priority-calculator.js';
import { createAuthManager, fetchSpotifyUserId } from './auth.js';
import { broadcastEvents, createBroadcaster } from './broadcast.js';
import {
  diffPriorities,
  snapshotPriorities,
  syncIfNeeded,
} from './priority-diff.js';
import {
  clearSessionCookie,
  getSessionUserId,
  setSessionCookie,
} from './session.js';
import { createTaskMutex } from './task-mutex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const PORT = Number(process.env.PORT ?? 3005);

// ── Shared Request Pacer (one per app — rate limit is per clientId) ──────────

const pacer = new RequestPacer(1); // 1 req/s base rate

// ── App Config ───────────────────────────────────────────────────────────────

const appConfigStore = new AppConfigStore();

function loadAppConfig(): AppConfig {
  return appConfigStore.load();
}

// ── Broadcast + Task Mutex ───────────────────────────────────────────────────

const broadcaster = createBroadcaster();
const broadcast = broadcaster.broadcast;

const searchedArtists = new Set<string>();

const taskMutex = createTaskMutex((busy, task) => {
  broadcast('status', { busy, task });
});

// ── Per-User Session Registry ────────────────────────────────────────────────

interface UserSession {
  userId: string;
  displayName?: string;
  client: SpotifyClient;
  userConfigStore: UserConfigStore;
  dataDir: string;
}

const sessions = new Map<string, UserSession>();

function getUserDataDir(userId: string): string {
  return path.join(USERS_DIR, userId);
}

function getOrCreateUserSession(
  userId: string,
  appConfig: AppConfig,
): UserSession {
  const existing = sessions.get(userId);
  if (existing) return existing;

  const dataDir = getUserDataDir(userId);
  fs.mkdirSync(dataDir, { recursive: true });

  const tokenStore = new UserTokenStore(userId, dataDir);
  const configStore = new BridgedConfigStore(appConfig, tokenStore);
  const userConfigStore = new UserConfigStore(
    path.join(dataDir, 'user-config.json'),
  );

  const client = createSpotifyClient({
    configStore,
    onAuthRequired: () =>
      broadcast('log', {
        level: 'warn',
        message:
          'Token expired — opening Spotify login. Task paused, waiting...',
      }),
    onAuthFailed: (err) =>
      broadcast('log', {
        level: 'error',
        message: `Auth failed: ${err.message}`,
      }),
  });

  // Override runAuth to pause and wait for dashboard auth
  client.runAuth = async () => {
    broadcast('log', {
      level: 'warn',
      message: 'Token expired — opening Spotify login. Task paused, waiting...',
    });
    const url = auth.buildAuthUrl();
    broadcast('auth', { authenticated: false, url });
    return auth.waitForAuth();
  };

  const session: UserSession = { userId, client, userConfigStore, dataDir };
  sessions.set(userId, session);
  return session;
}

function requireSession(
  req: express.Request,
  res: express.Response,
): UserSession | null {
  let appConfig: AppConfig;
  try {
    appConfig = loadAppConfig();
  } catch {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  const userId = getSessionUserId(req, appConfig.clientSecret);
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  return getOrCreateUserSession(userId, appConfig);
}

// ── Auth Manager ─────────────────────────────────────────────────────────────

const auth = createAuthManager({
  loadAppConfig,
  getOrCreateUserSession,
  getUserDataDir,
  broadcast,
  mainPort: PORT,
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function restoreSearchedArtistsFromCache(dataDir: string) {
  try {
    const cachePath = path.join(dataDir, 'batch-cache.json');
    const trustedPath = path.join(dataDir, 'trusted-artists.json');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const progress = cache?.artistSearchProgress;
    if (progress?.artistsSearched > 0) {
      const trusted = JSON.parse(fs.readFileSync(trustedPath, 'utf8'));
      const p1p2 = filterByPriority(trusted.artistCounts, [1, 2]);
      const count = Math.min(progress.artistsSearched, p1p2.length);
      for (let i = 0; i < count; i++) {
        searchedArtists.add(p1p2[i][0]);
      }
      broadcast('fill:searchedArtists', [...searchedArtists]);
      broadcast('log', {
        level: 'info',
        message: `Restored ${searchedArtists.size} searched artists from cache (date: ${progress.date})`,
      });
    }
  } catch {
    /* no cache or trusted-artists file */
  }
}

function loadTrustedArtists(dataDir: string): TrustedArtistsFile | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dataDir, 'trusted-artists.json'), 'utf8'),
    );
  } catch {
    return null;
  }
}

// ── Express + WebSocket ─────────────────────────────────────────────────────

const app = express();
app.use(express.json());
// In dev (--watch), serve from src; in prod, serve from build
const publicDir = fs.existsSync(path.join(__dirname, '../../src/web/public'))
  ? path.join(__dirname, '../../src/web/public')
  : path.join(__dirname, 'public');
app.use(express.static(publicDir));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  broadcaster.addClient(ws, taskMutex.currentTask, searchedArtists);
});

// ── Routes ──────────────────────────────────────────────────────────────────

// Fill playlists
app.post('/api/fill', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;

  const abort = taskMutex.setBusy('fill', session.userId);
  if (!abort) {
    res
      .status(409)
      .json({ error: `Busy: "${taskMutex.currentTask}" is running` });
    return;
  }

  const freshMode = !!req.body?.fresh;
  const abortableClient = taskMutex.createAbortableClient(session.client);
  searchedArtists.clear();
  broadcast('log', {
    level: 'info',
    message: `Starting playlist fill (fresh=${freshMode})...`,
  });
  if (!freshMode) restoreSearchedArtistsFromCache(session.dataDir);

  const userConfig = session.userConfigStore.load();

  const ctx = createSpotifyContext(
    abortableClient,
    {
      onRateLimitWait: (s) => {
        const resumeAt = new Date(Date.now() + s * 1000);
        const display = s >= 60 ? `${(s / 60).toFixed(1)}min` : `${s}s`;
        const time = resumeAt.toLocaleTimeString();
        broadcast('log', {
          level: 'info',
          message: `  Rate limited, waiting ${display} (until ${time})...`,
        });
        broadcast('fill:rateLimited', {
          seconds: s,
          wakeTime: resumeAt.toISOString(),
        });
      },
      onNetworkRetry: (a, m) =>
        broadcast('log', {
          level: 'info',
          message: `  Network error, retry ${a}/${m}`,
        }),
      onLongSleep: (h, w) => {
        broadcast('log', {
          level: 'warn',
          message: `Rate limited — sleeping ${h}h, waking at ${w.toLocaleTimeString()}`,
        });
        broadcast('fill:rateLimited', {
          seconds: h * 3600,
          wakeTime: w.toISOString(),
        });
      },
      onError: (desc, err) => {
        if (err.message?.includes('404')) return;
        broadcast('log', {
          level: 'info',
          message: `  Error (${desc}): ${err.message}`,
        });
      },
    },
    pacer,
  );

  const service = new PlaylistFillerService(
    ctx,
    {
      freshMode,
      allWeeklyId: userConfig.sourcePlaylists.allWeeklyId,
      bestOfAllWeeklyId: userConfig.sourcePlaylists.bestOfAllWeeklyId,
      editorialPlaylists: userConfig.editorialPlaylists,
      externalPlaylistSources: userConfig.externalPlaylistSources,
      genreFilters: userConfig.genreFilters,
      editorialFilter: userConfig.editorialFilter,
      cachePath: path.join(session.dataDir, 'batch-cache.json'),
      trustedArtistsPath: path.join(session.dataDir, 'trusted-artists.json'),
    },
    broadcastEvents<PlaylistFillerEventMap>(broadcast, {
      start: {
        type: 'fill:start',
        pack: (dates) => {
          taskMutex.checkAbort();
          return { dates };
        },
      },
      dateStart: {
        type: 'fill:progress',
        pack: (date, index, total) => {
          taskMutex.checkAbort();
          return { date, index, total, searched: searchedArtists.size };
        },
      },
      dateSkipped: {
        log: (date, reason, trackCount) =>
          `Skipped ${date}: ${reason} (${trackCount} tracks)`,
      },
      playlistCreated: {
        log: (date) => `Created playlist: ${date}`,
        level: 'success',
      },
      playlistReused: {
        log: (date) => `Reusing empty playlist: ${date}`,
      },
      artistSearchProgress: {
        type: 'fill:searchProgress',
        pack: (searched, total, artistName) => {
          taskMutex.checkAbort();
          searchedArtists.add(artistName);
          return { searched, total, artist: artistName };
        },
      },
      artistSearchPause: {
        log: (searched, total) =>
          `Pausing 30s to reset rate limit window (${searched}/${total} artists)`,
      },
      releaseFound: {
        type: 'fill:releaseFound',
        pack: (artist, release, type, source) => ({
          artist,
          release,
          type,
          source,
        }),
      },
      variantPicked: {
        log: (name, count, isExplicit) =>
          `Picked ${isExplicit ? 'explicit' : 'clean'} variant of "${name}" (${count} variants)`,
      },
      filtered: {
        log: (reason, artist, release, detail) =>
          `Filtered (${reason}${detail ? ` ${detail}` : ''}): ${artist} - ${release}`,
      },
      titleTrackOnly: {
        log: (releaseName, _trackName, oldTracks, totalOther) =>
          `Title track only: "${releaseName}" — ${oldTracks}/${totalOther} other tracks from older releases`,
      },
      deluxeDetected: {
        log: (name, baseName) => `Deluxe detected: "${name}" -> "${baseName}"`,
      },
      singleSkipped: {
        log: (name) =>
          `Skipped single "${name}" (tracks already on album)`,
      },
      dateCompleted: {
        type: 'fill:dateComplete',
        pack: (result) => result,
      },
      dateError: {
        type: 'fill:error',
        pack: (date, err) => ({ date, message: err.message }),
      },
      recalculating: {
        log: () => 'Playlist changed — recalculating priorities...',
      },
      recalculated: {
        type: 'fill:recalculated',
        pack: () => ({}),
      },
      batchComplete: {
        type: 'fill:complete',
        pack: (results, duration) => {
          searchedArtists.clear();
          return { results, duration };
        },
      },
      log: { log: (msg) => msg },
    }),
  );

  // Snapshot old priorities before fill
  const fillTrustedPath = path.join(session.dataDir, 'trusted-artists.json');
  const fillOldPriorities = snapshotPriorities(fillTrustedPath);

  service
    .run()
    .then(async (results) => {
      const completed = results.filter((r) => !(r.error || r.skipped));
      fs.writeFileSync(
        path.join(session.dataDir, 'batch-p1p2-progress.json'),
        JSON.stringify(
          { completed: completed.length, total: results.length, results },
          null,
          2,
        ),
      );

      // Append to fill history
      const totalTracks = completed.reduce(
        (s, r) => s + (r.tracksAdded || 0),
        0,
      );
      if (totalTracks > 0) {
        const historyPath = path.join(session.dataDir, 'fill-history.json');
        let history: any[] = [];
        try {
          history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        } catch {
          /* first run */
        }
        const releasesByPriority: Record<string, number> = {};
        for (const r of completed) {
          for (const rel of r.releases ?? []) {
            const key =
              rel.priority === 'editorial' ? 'editorial' : `p${rel.priority}`;
            releasesByPriority[key] = (releasesByPriority[key] || 0) + 1;
          }
        }
        history.push({
          timestamp: new Date().toISOString(),
          datesProcessed: completed.length,
          datesTotal: results.length,
          totalTracks,
          totalAlbums: completed.reduce((s, r) => s + (r.albumsCount || 0), 0),
          totalSingles: completed.reduce(
            (s, r) => s + (r.singlesCount || 0),
            0,
          ),
          totalSkipped: completed.reduce(
            (s, r) => s + (r.skippedCount || 0),
            0,
          ),
          releasesByPriority,
        });
        fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
      }

      // Post-fill sync
      try {
        const current = JSON.parse(
          fs.readFileSync(fillTrustedPath, 'utf-8'),
        ) as TrustedArtistsFile;
        const changes = diffPriorities(fillOldPriorities, current);
        await syncIfNeeded(
          changes,
          session.client,
          session.dataDir,
          userConfig.sourcePlaylists.allWeeklyId,
          pacer,
          broadcast,
        );
      } catch (syncErr) {
        broadcast('log', {
          level: 'warn',
          message: `Post-fill sync failed: ${syncErr}`,
        });
      }
    })
    .catch((err) => {
      if (abort.aborted) {
        broadcast('fill:stopped', {});
        broadcast('log', { level: 'warn', message: 'Fill stopped by user' });
      } else {
        broadcast('fill:error', { date: 'batch', message: String(err) });
      }
    })
    .finally(() => {
      searchedArtists.clear();
      taskMutex.setIdle();
    });

  res.json({ ok: true, message: 'Fill started' });
});

// Recalculate priorities
app.post('/api/recalculate', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;

  const abort = taskMutex.setBusy('recalculate', session.userId);
  if (!abort) {
    res
      .status(409)
      .json({ error: `Busy: "${taskMutex.currentTask}" is running` });
    return;
  }

  const abortableClient = taskMutex.createAbortableClient(session.client);
  broadcast('log', {
    level: 'info',
    message: 'Starting priority recalculation...',
  });

  const userConfig = session.userConfigStore.load();

  const ctx = createSpotifyContext(abortableClient, undefined, pacer);

  const service = new PriorityCalculatorService(
    ctx,
    {
      allWeeklyId: userConfig.sourcePlaylists.allWeeklyId,
      bestOfAllWeeklyId: userConfig.sourcePlaylists.bestOfAllWeeklyId,
      scoringWeights: userConfig.scoring,
      priorityThresholds: userConfig.scoring.priorityThresholds,
    },
    broadcastEvents<PriorityCalculatorEventMap>(broadcast, {
      scanStart: {
        type: 'recalc:scanStart',
        pack: (name) => {
          taskMutex.checkAbort();
          return { playlist: name };
        },
      },
      scanProgress: {
        type: 'recalc:scanProgress',
        pack: (name, offset, total) => {
          taskMutex.checkAbort();
          return { playlist: name, offset, total };
        },
      },
      scanComplete: {
        type: 'recalc:scanProgress',
        pack: (name, artistCount, trackCount) => ({
          playlist: name,
          artists: artistCount,
          tracks: trackCount,
        }),
      },
      calculationComplete: {
        type: 'recalc:complete',
        pack: (stats) => stats,
      },
      topArtists: {
        type: 'recalc:topArtists',
        pack: (artists) => ({
          artists: artists.map(([name, data]) => ({ name, ...data })),
        }),
      },
      saved: { log: (p) => `Saved to ${p}`, level: 'success' },
    }),
  );

  const trustedPath = path.join(session.dataDir, 'trusted-artists.json');
  const oldPriorities = snapshotPriorities(trustedPath);

  service
    .run()
    .then(async (output) => {
      fs.writeFileSync(trustedPath, JSON.stringify(output, null, 2));

      const changes = diffPriorities(oldPriorities, output);
      changes.sort(
        (a, b) =>
          (a.to ?? 99) - (b.to ?? 99) || (a.from ?? 99) - (b.from ?? 99),
      );
      broadcast('recalc:changes', { changes });

      broadcast('log', {
        level: 'success',
        message: 'Priorities recalculated and saved',
      });

      // Sync unprocessed playlists if P1/P2 boundary crossings occurred
      try {
        await syncIfNeeded(
          changes,
          session.client,
          session.dataDir,
          userConfig.sourcePlaylists.allWeeklyId,
          pacer,
          broadcast,
        );
      } catch (syncErr) {
        broadcast('log', {
          level: 'warn',
          message: `Post-recalc sync failed: ${syncErr}`,
        });
      }
    })
    .catch((err) => {
      if (abort.aborted) {
        broadcast('log', {
          level: 'warn',
          message: 'Recalculation stopped by user',
        });
      } else {
        broadcast('log', {
          level: 'error',
          message: `Recalculation failed: ${err}`,
        });
      }
    })
    .finally(() => taskMutex.setIdle());

  res.json({ ok: true, message: 'Recalculation started' });
});

// Find artist (local JSON search — no Spotify API needed)
app.post('/api/find-artist', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;

  const query = req.body?.query?.trim();
  if (!query) {
    res.status(400).json({ error: 'query is required' });
    return;
  }

  const trusted = loadTrustedArtists(session.dataDir);
  if (!trusted) {
    res.status(500).json({
      error: 'trusted-artists.json not found — run recalculate first',
    });
    return;
  }

  const queryLower = query.toLowerCase();
  const artists = trusted.artistCounts;

  // Pre-compute rankings per priority group
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

// Clear playlist
app.post('/api/clear', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;

  const name = req.body?.name?.trim();
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  broadcast('log', {
    level: 'info',
    message: `Clearing playlist "${name}"...`,
  });

  const ctx = createSpotifyContext(session.client, undefined, pacer);
  const service = new PlaylistClearerService(
    ctx,
    broadcastEvents<PlaylistClearerEventMap>(broadcast, {
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

// Dedup scan — find duplicate tracks in weekly playlists
app.post('/api/dedup-scan', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;

  const abort = taskMutex.setBusy('dedup-scan', session.userId);
  if (!abort) {
    res
      .status(409)
      .json({ error: `Busy: "${taskMutex.currentTask}" is running` });
    return;
  }

  res.json({ ok: true, message: 'Dedup scan started' });

  (async () => {
    const abortableClient = taskMutex.createAbortableClient(session.client);
    const ctx = createSpotifyContext(abortableClient, undefined, pacer);
    const userConfig = session.userConfigStore.load();
    const me = await abortableClient.api.currentUser.profile();
    const allPlaylists = await getAllUserPlaylists(ctx, me.id);

    // Load All Weekly track IDs to determine which weeklies have been processed
    const awTrackIds = new Set(
      await getAllPlaylistTracks(ctx, userConfig.sourcePlaylists.allWeeklyId),
    );
    broadcast('log', {
      level: 'info',
      message: `Loaded ${awTrackIds.size} tracks from All Weekly`,
    });

    // Filter to weekly DD.MM.YY playlists with tracks
    const weeklyPattern = /^(\d{2})\.(\d{2})\.(\d{2})$/;
    const candidates = allPlaylists.filter(
      (pl) => pl.trackCount > 0 && weeklyPattern.test(pl.name),
    );

    broadcast('log', {
      level: 'info',
      message: `Found ${candidates.length} weekly playlists, checking which are not in All Weekly...`,
    });

    const scanResults: Array<{
      name: string;
      id: string;
      duplicateCount: number;
      trackUris: string[];
    }> = [];
    let totalDuplicates = 0;
    let skippedInAw = 0;

    for (const pl of candidates) {
      taskMutex.checkAbort();
      const tracks = await getPlaylistTracksDetailed(ctx, pl.id);

      // Check if any tracks are already in All Weekly — if so, skip
      const hasAwOverlap = tracks.some((t) => {
        const id = t.uri.split(':')[2];
        return id && awTrackIds.has(id);
      });
      if (hasAwOverlap) {
        skippedInAw++;
        continue;
      }

      // Group by key
      const groups = new Map<
        string,
        Array<{ uri: string; name: string; artists: string }>
      >();
      for (const t of tracks) {
        if (!groups.has(t.key)) groups.set(t.key, []);
        groups.get(t.key)?.push(t);
      }

      // Find duplicates (keep first, mark rest for removal)
      const duplicates: Array<{
        artist: string;
        track: string;
        count: number;
      }> = [];
      const urisToRemove: string[] = [];

      for (const [, entries] of groups) {
        if (entries.length > 1) {
          duplicates.push({
            artist: entries[0].artists,
            track: entries[0].name,
            count: entries.length,
          });
          // Keep first occurrence, remove the rest
          for (let i = 1; i < entries.length; i++) {
            urisToRemove.push(entries[i].uri);
          }
        }
      }

      if (duplicates.length > 0) {
        const dupCount = urisToRemove.length;
        totalDuplicates += dupCount;
        scanResults.push({
          name: pl.name,
          id: pl.id,
          duplicateCount: dupCount,
          trackUris: urisToRemove,
        });
        broadcast('dedup:playlist', { name: pl.name, duplicates });
      }
    }

    broadcast('dedup:scanComplete', {
      playlists: scanResults,
      totalDuplicates,
    });
    const scanned = candidates.length - skippedInAw;
    if (totalDuplicates === 0) {
      broadcast('log', {
        level: 'success',
        message: `No duplicates found (scanned ${scanned}, skipped ${skippedInAw} already in AW)`,
      });
    } else {
      broadcast('log', {
        level: 'info',
        message: `Found ${totalDuplicates} duplicate tracks across ${scanResults.length} playlists (scanned ${scanned}, skipped ${skippedInAw} already in AW)`,
      });
    }
  })()
    .catch((err) => {
      if (abort.aborted) {
        broadcast('log', {
          level: 'warn',
          message: 'Dedup scan stopped by user',
        });
      } else {
        broadcast('log', {
          level: 'error',
          message: `Dedup scan failed: ${err}`,
        });
      }
    })
    .finally(() => taskMutex.setIdle());
});

// Dedup remove — remove duplicate tracks from playlists
app.post('/api/dedup-remove', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;

  const playlists: Array<{ id: string; uris: string[] }> = req.body?.playlists;
  if (!(playlists && Array.isArray(playlists)) || playlists.length === 0) {
    res.status(400).json({ error: 'playlists array is required' });
    return;
  }

  const abort = taskMutex.setBusy('dedup-remove', session.userId);
  if (!abort) {
    res
      .status(409)
      .json({ error: `Busy: "${taskMutex.currentTask}" is running` });
    return;
  }

  res.json({ ok: true, message: 'Dedup removal started' });

  (async () => {
    const abortableClient = taskMutex.createAbortableClient(session.client);
    let totalRemoved = 0;

    for (const pl of playlists) {
      taskMutex.checkAbort();
      // Spotify API allows removing up to 100 tracks per request
      const batchSize = 100;
      for (let i = 0; i < pl.uris.length; i += batchSize) {
        taskMutex.checkAbort();
        const batch = pl.uris.slice(i, i + batchSize);
        await abortableClient.api.playlists.removeItemsFromPlaylist(pl.id, {
          tracks: batch.map((uri) => ({ uri })),
        });
        totalRemoved += batch.length;
      }
    }

    broadcast('dedup:complete', { totalRemoved });
    broadcast('log', {
      level: 'success',
      message: `Removed ${totalRemoved} duplicate tracks`,
    });
  })()
    .catch((err) => {
      if (abort.aborted) {
        broadcast('log', {
          level: 'warn',
          message: 'Dedup removal stopped by user',
        });
      } else {
        broadcast('log', {
          level: 'error',
          message: `Dedup removal failed: ${err}`,
        });
      }
    })
    .finally(() => taskMutex.setIdle());
});

// Stats
app.get('/api/stats', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;

  const trusted = loadTrustedArtists(session.dataDir);

  let overview: any = null;
  let scoreDistribution: any[] | null = null;

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

  let fillHistory: any[] = [];
  try {
    fillHistory = JSON.parse(
      fs.readFileSync(path.join(session.dataDir, 'fill-history.json'), 'utf8'),
    );
  } catch {
    /* no file */
  }

  res.json({ ok: true, stats: { overview, scoreDistribution, fillHistory } });
});

// List artists
app.get('/api/artists', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;

  const trusted = loadTrustedArtists(session.dataDir);
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

// Stop running task
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

// Clear log history
app.post('/api/clear-logs', (_req, res) => {
  broadcaster.clearHistory();
  res.json({ ok: true });
});

// Status
app.get('/api/status', (_req, res) => {
  res.json({ busy: !!taskMutex.currentTask, task: taskMutex.currentTask });
});

// ── User Config ──────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;

  const config = session.userConfigStore.load();
  res.json({ ok: true, config, configured: session.userConfigStore.exists() });
});

app.put('/api/config', (req, res) => {
  const session = requireSession(req, res);
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
  broadcast('log', { level: 'success', message: 'Settings saved' });
  res.json({ ok: true });
});

app.get('/api/user-playlists', async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;

  try {
    const me = await session.client.api.currentUser.profile();
    const ctx = createSpotifyContext(session.client, undefined, pacer);
    const playlists = await getAllUserPlaylists(ctx, me.id);
    res.json({ ok: true, playlists });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/search-playlists', async (req, res) => {
  const session = requireSession(req, res);
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

app.get('/api/artist-releases', async (req, res) => {
  const session = requireSession(req, res);
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

app.get('/api/playlist-info', async (req, res) => {
  const session = requireSession(req, res);
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

// ── Auth Routes ──────────────────────────────────────────────────────────────

app.get('/api/auth', (_req, res) => {
  res.json({ ok: true, url: auth.buildAuthUrl() });
});

// Handle callback on our own port (if redirect URI matches)
app.get('/callback', (req, res) => auth.handleAuthCallback(req, res));

// Exchange one-time auth token for session cookie
app.get('/api/auth/complete', (req, res) => {
  const token = req.query.token as string;
  if (!token) {
    res.status(400).send('<h1>Missing token</h1>');
    return;
  }
  const userId = auth.consumeAuthToken(token);
  if (!userId) {
    res.status(400).send('<h1>Invalid or expired token</h1>');
    return;
  }
  const appConfig = loadAppConfig();
  setSessionCookie(res, userId, appConfig.clientSecret);
  res.send(
    `<h1>Authenticated!</h1><p>You can close this tab and return to the <a href="http://localhost:${PORT}">dashboard</a>.</p>`,
  );
});

// Check if tokens are valid by making a real API call
app.get('/api/auth/status', async (req, res) => {
  let appConfig: AppConfig;
  try {
    appConfig = loadAppConfig();
  } catch {
    res.json({ authenticated: false, reason: 'no_session' });
    return;
  }
  const userId = getSessionUserId(req, appConfig.clientSecret);
  if (!userId) {
    res.json({ authenticated: false, reason: 'no_session' });
    return;
  }
  try {
    const session = getOrCreateUserSession(userId, appConfig);
    await session.client.refreshToken();
    const profile = await session.client.api.currentUser.profile();
    session.displayName = profile.display_name ?? profile.id;
    res.json({ authenticated: true, displayName: session.displayName });
  } catch {
    res.json({ authenticated: false, reason: 'expired' });
  }
});

// Logout
app.post('/api/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ── Migration ───────────────────────────────────────────────────────────────

async function migrateFromLegacy() {
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
    appConfigStore.save(appConfig);
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
        const userDir = getUserDataDir(userId);
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
  server.listen(PORT, () => {
    console.log(`Dashboard running at http://localhost:${PORT}`);
  });
});
