import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { formatDdMmYy } from '../domain/tracks.js';
import type { EventHandlers } from '../lib/service-events.js';
import type { SpotifyContext } from '../lib/spotify-context.js';
import type { BatchCache, TrustedArtistsFile } from '../lib/types.js';
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

// ── Fixture: a single already-filled Friday ─────────────────────────────────
// Every test drives `runFill` through its "everything is already filled"
// early-return branch, which skips the per-date search/collect loop (already
// covered by week-collection.test.ts) but still runs the shared post-fill
// tail this refactor introduced: progress/history, priority-diff, sync-gate.

function mostRecentFriday(from: Date): Date {
  const d = new Date(from);
  while (d.getDay() !== 5) d.setDate(d.getDate() - 1);
  return d;
}
const FILLED_FRIDAY = formatDdMmYy(mostRecentFriday(new Date()));

// ── Fixture: in-memory FillStorage ──────────────────────────────────────────
// `loadTrustedArtists` returns `before` on its first call and `after` on every
// call after that — modeling the roster changing while the fill is running
// (what a real mid-fill recalculation produces) without the scan engine.

function memoryStorage(
  before: TrustedArtistsFile,
  after: TrustedArtistsFile = before,
  dataDir = '/fixture',
): FillStorage & { history: FillHistoryEntry[]; progress?: ProgressFile } {
  let cache: BatchCache = {};
  let loadCalls = 0;
  const history: FillHistoryEntry[] = [];
  let progress: ProgressFile | undefined;
  return {
    dataDir,
    async loadBatchCache() {
      return cache;
    },
    async saveBatchCache(c) {
      cache = c;
    },
    async loadTrustedArtists() {
      loadCalls++;
      return loadCalls === 1 ? before : after;
    },
    async saveTrustedArtists() {
      /* not exercised: the early-return path never recalculates */
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
  artistCounts: TrustedArtistsFile['artistCounts'] = {},
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
   * Throw this when reading this playlist's items. Pagination's `runPagination`
   * propagates read failures (unlike the write adapters below, which currently
   * discard `ctx.call`'s result — see the note on `removeItemsFromPlaylist`).
   */
  failReadingPlaylist?: { id: string; error: Error };
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
            tracks: { total: 1 },
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

function noopSyncHandlers(): SyncHandlers {
  return {
    onProgress() {},
    onLog() {},
    onComplete() {},
  };
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

function options(overrides: Partial<FillRunOptions> = {}): FillRunOptions {
  return {
    ctx: fixtureCtx({ userId: 'user-1' }),
    config: { allWeeklyId: 'aw-playlist', bestOfAllWeeklyId: 'boaw-playlist' },
    storage: memoryStorage(trusted()),
    handlers: {} as EventHandlers<PlaylistFillerEventMap>,
    syncHandlers: noopSyncHandlers(),
    fresh: true,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('no priority changes: progress is written, sync never runs', async () => {
  const storage = memoryStorage(trusted());
  const result = await runFill(options({ storage }));

  assert.deepEqual(result.priorityChanges, []);
  assert.equal(result.syncedPlaylists, null);
  assert.ok(storage.progress);
  assert.equal(storage.progress?.total, 0);
});

test('a zero-track run never appends a fill-history entry', async () => {
  const storage = memoryStorage(trusted());
  await runFill(options({ storage }));

  assert.deepEqual(storage.history, []);
});

// A single demoted artist (P1 -> P4) whose track sits, unlistened, on the one
// weekly playlist — the minimal fixture that reaches promotion sync's removal
// phase without needing artist/album/popularity lookups.
function demotionScenario(
  t: { after: (fn: () => void) => void },
  failReadingPlaylist?: { id: string; error: Error },
) {
  const before = trusted({
    'Demoted Artist': { priority: 1, score: 100 },
  } as unknown as TrustedArtistsFile['artistCounts']);
  const after = trusted({
    'Demoted Artist': { priority: 4, score: 10 },
  } as unknown as TrustedArtistsFile['artistCounts']);

  const ctx = fixtureCtx({
    userId: 'user-1',
    failReadingPlaylist,
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
  });
  const storage = memoryStorage(before, after, tmpDataDir(t));
  return { ctx, storage };
}

test('a demotion crossing the P1/P2 boundary syncs it out of the non-listened playlist', async (t) => {
  const { ctx, storage } = demotionScenario(t);

  const result = await runFill(options({ ctx, storage }));

  assert.deepEqual(result.priorityChanges, [
    { artist: 'Demoted Artist', from: 1, to: 4 },
  ]);
  assert.equal(result.syncedPlaylists, 1);
  assert.deepEqual(ctx.removed['pl-filled'], ['spotify:track:demoted-track']);
});

test('a sync failure is logged as a warning but does not fail the fill', async (t) => {
  const { ctx, storage } = demotionScenario(t, {
    id: 'aw-playlist',
    error: new Error('spotify 500'),
  });
  const syncHandlers = recordingSyncHandlers();

  const result = await runFill(options({ ctx, storage, syncHandlers }));

  assert.deepEqual(result.priorityChanges, [
    { artist: 'Demoted Artist', from: 1, to: 4 },
  ]);
  assert.equal(result.syncedPlaylists, null);
  assert.ok(syncHandlers.logs.some((l) => l.includes('Post-fill sync failed')));
});

test('an abort during sync propagates instead of being swallowed', async (t) => {
  const abortError = new Error('Stopped by user');
  abortError.name = 'AbortError';
  const { ctx, storage } = demotionScenario(t, {
    id: 'aw-playlist',
    error: abortError,
  });

  await assert.rejects(runFill(options({ ctx, storage })), /Stopped by user/);
});

test('a priority move that stays outside P1/P2 is reported but does not sync', async () => {
  const before = trusted({
    'Mid Artist': { priority: 3, score: 20 },
  } as unknown as TrustedArtistsFile['artistCounts']);
  const after = trusted({
    'Mid Artist': { priority: 4, score: 5 },
  } as unknown as TrustedArtistsFile['artistCounts']);
  const storage = memoryStorage(before, after);

  const result = await runFill(options({ storage }));

  assert.deepEqual(result.priorityChanges, [
    { artist: 'Mid Artist', from: 3, to: 4 },
  ]);
  assert.equal(result.syncedPlaylists, null);
});
