import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { formatDdMmYy } from '../domain/tracks.js';
import {
  PENDING_PRIORITY_CHANGES,
  RECALCULATION_STATE,
  TRUSTED_ARTISTS,
} from '../lib/cache-files.js';
import { type DurableCache, createDurableCache } from '../lib/durable-cache.js';
import type { EventHandlers } from '../lib/service-events.js';
import type { SpotifyContext } from '../lib/spotify-context.js';
import type { BatchCache, TrustedArtistsFile } from '../lib/types.js';
import { DEFAULT_USER_CONFIG, type UserConfig } from '../lib/user-config.js';
import type { PlaylistFillerEventMap } from '../services/playlist-filler/events.js';
import {
  type FillRunOptions,
  runFill,
} from '../services/playlist-filler/fill-run.js';
import type {
  FillHistoryEntry,
  FillStorage,
  ProgressFile,
} from '../services/playlist-filler/storage.js';
import type { SyncHandlers } from '../services/promotion-sync/subscribers.js';
import { spotifyRecalculationPorts } from '../services/recalculation/adapters.js';
import type { SourceReads } from '../services/recalculation/index.js';

// ── Fixture: a single weekly Friday ─────────────────────────────────────────
// Most tests drive `runFill` through its "everything is already filled"
// early-return branch, which skips the per-date search/collect loop (covered
// by week-collection.test.ts) but still runs the shared post-fill tail:
// progress/history and the trailing promotion sync of pending changes.

function mostRecentFriday(from: Date): Date {
  const d = new Date(from);
  while (d.getDay() !== 5) d.setDate(d.getDate() - 1);
  return d;
}
const FILLED_FRIDAY = formatDdMmYy(mostRecentFriday(new Date()));

// ── Fixture: in-memory FillStorage (the fill's own data) ─────────────────────

function memoryStorage(): FillStorage & {
  history: FillHistoryEntry[];
  progress?: ProgressFile;
} {
  let cache: BatchCache = {};
  const history: FillHistoryEntry[] = [];
  let progress: ProgressFile | undefined;
  return {
    async loadBatchCache() {
      return cache;
    },
    async saveBatchCache(c) {
      cache = c;
    },
    async appendFillHistory(entry) {
      history.push(entry);
    },
    async saveProgress(p) {
      progress = p;
    },
    get history() {
      return history;
    },
    get progress() {
      return progress;
    },
  };
}

function trusted(
  artistCounts: Record<string, { priority: number | null; score: number }> = {},
): TrustedArtistsFile {
  return { artistCounts } as unknown as TrustedArtistsFile;
}

// ── Fixture: fake SpotifyContext ────────────────────────────────────────────

interface FixtureTrack {
  id: string;
  artistNames: string[];
  albumId?: string;
}

interface FixtureWorld {
  userId: string;
  /** playlistId -> tracks, keyed by the same id used for both AW and weeklies. */
  playlistTracks?: Record<string, FixtureTrack[]>;
  /**
   * Throw this when reading this playlist's items — the simplest way to make
   * the trailing promotion sync fail, since pagination's `runPagination`
   * propagates read failures.
   */
  failReadingPlaylist?: { id: string; error: Error };
  /** The Friday's playlist exists but is still empty, so the fill processes it. */
  unfilled?: boolean;
}

function fixtureCtx(world: FixtureWorld): SpotifyContext & {
  removed: Record<string, string[]>;
} {
  const removed: Record<string, string[]> = {};
  const track = (t: FixtureTrack) => ({
    id: t.id,
    uri: `spotify:track:${t.id}`,
    name: t.id,
    artists: t.artistNames.map((name) => ({ name })),
    album: { id: t.albumId ?? t.id },
  });

  const api = {
    currentUser: { profile: async () => ({ id: world.userId }) },
    playlists: {
      getUsersPlaylists: async (
        _userId: string,
        limit: number,
        offset: number,
      ) => {
        const all = [
          {
            id: 'pl-filled',
            name: FILLED_FRIDAY,
            owner: { id: world.userId },
            tracks: { total: world.unfilled ? 0 : 1 },
          },
        ];
        return { items: all.slice(offset, offset + limit), total: all.length };
      },
      getPlaylistItems: async (
        playlistId: string,
        _market: unknown,
        _fields: unknown,
        limit: number,
        offset: number,
      ) => {
        if (world.failReadingPlaylist?.id === playlistId) {
          throw world.failReadingPlaylist.error;
        }
        const tracks = world.playlistTracks?.[playlistId] ?? [];
        const page = tracks.slice(offset, offset + limit).map((t) => ({
          track: track(t),
        }));
        return { items: page, total: tracks.length };
      },
      removeItemsFromPlaylist: async (
        playlistId: string,
        opts: { tracks: Array<{ uri: string }> },
      ) => {
        removed[playlistId] ??= [];
        removed[playlistId].push(...opts.tracks.map((t) => t.uri));
        return {};
      },
    },
  };

  return {
    api: api as unknown as SpotifyContext['api'],
    client: {
      api: api as unknown as SpotifyContext['api'],
      async refreshToken() {
        return 'token';
      },
      async recreateApi() {
        return api as unknown as SpotifyContext['api'];
      },
      async runAuth() {
        return true;
      },
    },
    async call(fn) {
      try {
        return { success: true, data: await fn() };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        // Mirrors lib/api-wrapper.ts::createApiCall: abort errors are rethrown
        // immediately rather than folded into a failed ApiResult, which is how
        // an abort propagates cleanly through pagination's strict error mode.
        if (err.name === 'AbortError' || err.message === 'Stopped by user') {
          throw err;
        }
        return { success: false, error: err };
      }
    },
    removed,
  };
}

function tmpDataDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-run-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function recordingSyncHandlers(): SyncHandlers & { logs: string[] } {
  const logs: string[] = [];
  return {
    onProgress() {},
    onLog(message) {
      logs.push(message);
    },
    onComplete() {},
    logs,
  };
}

const USER_CONFIG: UserConfig = {
  ...DEFAULT_USER_CONFIG,
  sourcePlaylists: {
    ...DEFAULT_USER_CONFIG.sourcePlaylists,
    allWeeklyId: 'aw-playlist',
    bestOfAllWeeklyId: 'boaw-playlist',
    useLikedSongs: false,
  },
};

/**
 * Real production ports over the fixture context, persisting to a temp dir.
 * `sources` swaps in fixture source playlists for the mid-fill recalculation.
 */
function world(
  t: { after: (fn: () => void) => void },
  ctx: SpotifyContext,
  sources?: SourceReads,
) {
  const dataDir = tmpDataDir(t);
  const cache = createDurableCache({ userId: 'user-1', dataDir, redis: null });
  const ports = spotifyRecalculationPorts(ctx, { userId: 'user-1', dataDir });
  return {
    cache,
    options(overrides: Partial<FillRunOptions> = {}): FillRunOptions {
      return {
        ctx,
        userConfig: USER_CONFIG,
        storage: memoryStorage(),
        recalculation: {
          cache,
          ports: sources ? { ...ports, sources } : ports,
        },
        handlers: {} as EventHandlers<PlaylistFillerEventMap>,
        syncHandlers: recordingSyncHandlers(),
        fresh: true,
        ...overrides,
      };
    },
  };
}

// A demoted artist (P1 -> P4) whose track sits, unlistened, on the one weekly
// playlist — the minimal fixture that reaches promotion sync's removal phase
// without needing artist/album/popularity lookups.
const DEMOTION = { artist: 'Demoted Artist', from: 1, to: 4 };

function demotionCtx(opts: Partial<FixtureWorld> = {}) {
  return fixtureCtx({
    userId: 'user-1',
    playlistTracks: {
      'aw-playlist': [{ id: 'aw-track', artistNames: ['Someone Else'] }],
      'pl-filled': [
        {
          id: 'demoted-track',
          artistNames: ['Demoted Artist'],
          albumId: 'alb-1',
        },
      ],
    },
    ...opts,
  });
}

async function seedPending(cache: DurableCache) {
  await cache.save(
    TRUSTED_ARTISTS,
    trusted({ 'Demoted Artist': { priority: 4, score: 10 } }),
  );
  await cache.save(PENDING_PRIORITY_CHANGES, [DEMOTION]);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('nothing pending: progress is written, sync never runs', async (t) => {
  const storage = memoryStorage();
  const w = world(t, fixtureCtx({ userId: 'user-1' }));
  const result = await runFill(w.options({ storage }));

  assert.deepEqual(result.priorityChanges, []);
  assert.equal(result.syncedPlaylists, null);
  assert.equal(storage.progress?.total, 0);
});

test('a zero-track run never appends a fill-history entry', async (t) => {
  const storage = memoryStorage();
  const w = world(t, fixtureCtx({ userId: 'user-1' }));
  await runFill(w.options({ storage }));

  assert.deepEqual(storage.history, []);
});

test('the trailing sync applies pending changes and clears them', async (t) => {
  const ctx = demotionCtx();
  const w = world(t, ctx);
  await seedPending(w.cache);

  const result = await runFill(w.options());

  assert.equal(result.syncedPlaylists, 1);
  assert.deepEqual(ctx.removed['pl-filled'], ['spotify:track:demoted-track']);
  assert.equal(await w.cache.load(PENDING_PRIORITY_CHANGES), null);
});

test('a sync failure is logged as a warning, fails nothing, and stays pending', async (t) => {
  const ctx = demotionCtx({
    failReadingPlaylist: { id: 'aw-playlist', error: new Error('spotify 500') },
  });
  const w = world(t, ctx);
  await seedPending(w.cache);
  const syncHandlers = recordingSyncHandlers();

  const result = await runFill(w.options({ syncHandlers }));

  assert.equal(result.syncedPlaylists, null);
  assert.ok(syncHandlers.logs.some((l) => l.includes('Post-fill sync failed')));
  assert.deepEqual(await w.cache.load(PENDING_PRIORITY_CHANGES), [DEMOTION]);
});

test('an abort during sync propagates instead of being swallowed', async (t) => {
  const abortError = new Error('Stopped by user');
  abortError.name = 'AbortError';
  const w = world(
    t,
    demotionCtx({
      failReadingPlaylist: { id: 'aw-playlist', error: abortError },
    }),
  );
  await seedPending(w.cache);

  await assert.rejects(runFill(w.options()), /Stopped by user/);
});

test('a fill aborted after a mid-fill recalculation leaves the sync for the next fill', async (t) => {
  // AW changed since the last recalculation, and the artist's plays dropped.
  const sources: SourceReads = {
    async snapshots() {
      return { aw: 'aw-2', boaw: 'boaw-1' };
    },
    async scan() {
      return {
        artistData: new Map([
          [
            'Demoted Artist',
            {
              primaryCount: 1,
              featuredCount: 0,
              latestPosition: 1,
              featuredAtLatest: false,
              id: null,
            },
          ],
        ]),
        totalTracks: 1000,
      };
    },
  };
  const abortError = new Error('Stopped by user');
  abortError.name = 'AbortError';

  const first = world(t, demotionCtx({ unfilled: true }), sources);
  await first.cache.save(
    TRUSTED_ARTISTS,
    trusted({ 'Demoted Artist': { priority: 1, score: 100 } }),
  );
  await first.cache.save(RECALCULATION_STATE, {
    allWeeklySnapshot: 'aw-1',
    bestOfAllWeeklySnapshot: 'boaw-1',
  });
  const handlers = {
    onRecalculated: () => {
      throw abortError; // the user stops the fill right after it re-scored
    },
  } as EventHandlers<PlaylistFillerEventMap>;

  await assert.rejects(runFill(first.options({ handlers })), /Stopped/);
  const pending = await first.cache.load(PENDING_PRIORITY_CHANGES);
  assert.equal(pending?.[0]?.artist, 'Demoted Artist');
  assert.equal(pending?.[0]?.from, 1);

  // The next fill finds every Friday filled, and its trailing sync applies it.
  const ctx = demotionCtx();
  const next = await runFill({
    ...first.options(),
    ctx,
    recalculation: {
      cache: first.cache,
      ports: spotifyRecalculationPorts(ctx, {
        userId: 'user-1',
        dataDir: tmpDataDir(t),
      }),
    },
  });

  assert.equal(next.syncedPlaylists, 1);
  assert.deepEqual(ctx.removed['pl-filled'], ['spotify:track:demoted-track']);
});
