import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { formatDateISO, formatDdMmYy } from '../domain/tracks.js';
import {
  PENDING_PRIORITY_CHANGES,
  RECALCULATION_STATE,
  TRUSTED_ARTISTS,
} from '../lib/cache-files.js';
import { type DurableCache, createDurableCache } from '../lib/durable-cache.js';
import type { EventHandlers } from '../lib/service-events.js';
import type { SpotifyContext } from '../lib/spotify-context.js';
import type {
  BatchCache,
  SimplePlaylist,
  TrustedArtistsFile,
} from '../lib/types.js';
import { DEFAULT_USER_CONFIG, type UserConfig } from '../lib/user-config.js';
import { fillPorts } from '../services/playlist-filler/adapters.js';
import type { PlaylistFillerEventMap } from '../services/playlist-filler/events.js';
import {
  type FillPorts,
  type FillRunOptions,
  runFill,
} from '../services/playlist-filler/fill-run.js';
import type {
  FillHistoryEntry,
  FillStorage,
  ProgressFile,
} from '../services/playlist-filler/storage.js';
import type { SyncHandlers } from '../services/promotion-sync/subscribers.js';
import type {
  RecalculationPorts,
  SourceReads,
} from '../services/recalculation/index.js';
import {
  fixedPopularitySource,
  memoryCheckpoints,
} from '../services/week-collection/adapters.js';
import { memoryWeeklyPlaylistStore } from '../services/weekly-playlists/adapters.js';
import {
  type Catalog,
  fixtureReads,
  recordingWrites,
} from './fixtures/release-catalog.js';

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
      setTokens() {},
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
  const storage = memoryStorage();
  const ports = fillPorts(ctx, { userId: 'user-1', dataDir, storage });
  if (sources) ports.recalculation = { ...ports.recalculation, sources };
  return {
    cache,
    storage,
    options(overrides: Partial<FillRunOptions> = {}): FillRunOptions {
      return {
        ctx,
        userId: 'user-1',
        userConfig: USER_CONFIG,
        storage,
        cache,
        ports,
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
  const w = world(t, fixtureCtx({ userId: 'user-1' }));
  const result = await runFill(w.options());

  assert.deepEqual(result.priorityChanges, []);
  assert.equal(result.syncedPlaylists, null);
  assert.equal(w.storage.progress?.total, 0);
});

test('a zero-track run never appends a fill-history entry', async (t) => {
  const w = world(t, fixtureCtx({ userId: 'user-1' }));
  await runFill(w.options());

  assert.deepEqual(w.storage.history, []);
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
    ports: fillPorts(ctx, {
      userId: 'user-1',
      dataDir: tmpDataDir(t),
      storage: first.storage,
    }),
  });

  assert.equal(next.syncedPlaylists, 1);
  assert.deepEqual(ctx.removed['pl-filled'], ['spotify:track:demoted-track']);
});

// ── Fixture: in-memory fill ports ────────────────────────────────────────────
// The per-date loop end to end: week collection over the catalog fixture, the
// weekly playlist write into a memory store, and recalculation ports whose
// sources never change, so the roster is whatever the cache holds.

const THIS_FRIDAY = FILLED_FRIDAY;
const LAST_FRIDAY = formatDdMmYy(
  new Date(mostRecentFriday(new Date()).getTime() - 7 * 86_400_000),
);
const IN_WINDOW = formatDateISO(mostRecentFriday(new Date()));

/** One P1 artist with one in-window, one-track album. */
function alphaCatalog(): Catalog {
  return {
    artists: [
      {
        id: 'art-a',
        name: 'Alpha',
        albums: [
          {
            id: 'alb-x',
            name: 'X',
            type: 'album',
            release_date: IN_WINDOW,
            tracks: [{ id: 't1', name: 'One', key: 'alpha::one' }],
          },
        ],
      },
    ],
  };
}

const ALPHA_P1 = trusted({ Alpha: { priority: 1, score: 100 } });

function unchangedRecalculation(
  catalog: Catalog,
  calls: string[],
): RecalculationPorts {
  return {
    sources: {
      async snapshots() {
        return { aw: 'aw-1', boaw: 'boaw-1' };
      },
      async scan() {
        calls.push('scan');
        return { artistData: new Map(), totalTracks: 0 };
      },
    },
    unprocessed: {
      async find() {
        return { playlists: [], awTrackIds: new Set() };
      },
      async invalidate() {
        calls.push('invalidate');
      },
    },
    sync: {
      reads: fixtureReads(catalog),
      popularity: fixedPopularitySource({}),
      writes: recordingWrites(),
    },
  };
}

function memoryPorts(catalog: Catalog, weeklies: SimplePlaylist[]) {
  const calls: string[] = [];
  const weekly = memoryWeeklyPlaylistStore(weeklies, calls);
  const checkpoints = memoryCheckpoints();
  const reads = fixtureReads(catalog);
  const ports: FillPorts = {
    week: {
      reads,
      popularity: fixedPopularitySource({ 'alb-x': 70, 'alb-y': 70 }),
      checkpoints,
    },
    weekly,
    history: {
      async playlistTrackIds() {
        return [];
      },
    },
    recalculation: unchangedRecalculation(catalog, calls),
  };
  return { ports, reads, weekly, checkpoints, calls };
}

/** A roster the mid-fill recalculation will keep: both sources unchanged. */
async function seedRoster(cache: DurableCache, roster: TrustedArtistsFile) {
  await cache.save(TRUSTED_ARTISTS, roster);
  await cache.save(RECALCULATION_STATE, {
    allWeeklySnapshot: 'aw-1',
    bestOfAllWeeklySnapshot: 'boaw-1',
  });
}

function memoryWorld(t: { after: (fn: () => void) => void }, ports: FillPorts) {
  const dataDir = tmpDataDir(t);
  const cache = createDurableCache({ userId: 'user-1', dataDir, redis: null });
  const storage = memoryStorage();
  return {
    cache,
    storage,
    options(overrides: Partial<FillRunOptions> = {}): FillRunOptions {
      return {
        ctx: fixtureCtx({ userId: 'user-1' }),
        userId: 'user-1',
        userConfig: USER_CONFIG,
        storage,
        cache,
        ports,
        handlers: {} as EventHandlers<PlaylistFillerEventMap>,
        syncHandlers: recordingSyncHandlers(),
        ...overrides,
      };
    },
  };
}

// ── Per-date loop ────────────────────────────────────────────────────────────

test('a fill collects one unfilled Friday and writes it to a new weekly playlist', async (t) => {
  const { ports, weekly } = memoryPorts(alphaCatalog(), [
    { id: 'pl-last', name: LAST_FRIDAY, trackCount: 3 },
  ]);
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);
  const created: string[] = [];

  const result = await runFill(
    w.options({
      handlers: {
        onPlaylistCreated: (date) => created.push(date),
      } as EventHandlers<PlaylistFillerEventMap>,
    }),
  );

  assert.deepEqual(created, [THIS_FRIDAY]);
  assert.deepEqual(
    weekly.created.map((p) => p.name),
    [THIS_FRIDAY],
  );
  assert.deepEqual(weekly.added.get(weekly.created[0].id), ['t1']);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].date, THIS_FRIDAY);
  assert.equal(result.results[0].tracksAdded, 1);
  assert.equal(w.storage.history.length, 1);
});

test("a failed track write is recorded as the date's error, not as success", async (t) => {
  const { ports, weekly } = memoryPorts(alphaCatalog(), [
    { id: 'pl-last', name: LAST_FRIDAY, trackCount: 3 },
  ]);
  weekly.failAddWith = new Error('rate limited');
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);
  const errors: string[] = [];

  const result = await runFill(
    w.options({
      handlers: {
        onDateError: (date, err) => errors.push(`${date}: ${err.message}`),
      } as EventHandlers<PlaylistFillerEventMap>,
    }),
  );

  assert.deepEqual(errors, [`${THIS_FRIDAY}: rate limited`]);
  assert.equal(result.results[0].error, 'rate limited');
  assert.deepEqual(w.storage.history, []);
});

test('an empty weekly playlist for the Friday is reused, never recreated', async (t) => {
  const { ports, weekly } = memoryPorts(alphaCatalog(), [
    { id: 'pl-empty', name: THIS_FRIDAY, trackCount: 0 },
  ]);
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);
  const reused: string[] = [];

  const result = await runFill(
    w.options({
      handlers: {
        onPlaylistReused: (_date, id) => reused.push(id),
      } as EventHandlers<PlaylistFillerEventMap>,
    }),
  );

  assert.deepEqual(reused, ['pl-empty']);
  assert.deepEqual(weekly.created, []);
  assert.deepEqual(weekly.added.get('pl-empty'), ['t1']);
  assert.equal(result.results[0].playlistId, 'pl-empty');
});

test('a filled Friday is not among the dates the fill processes', async (t) => {
  const { ports, weekly, calls } = memoryPorts(alphaCatalog(), [
    { id: 'pl-done', name: THIS_FRIDAY, trackCount: 5 },
  ]);
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);

  const result = await runFill(w.options());

  assert.deepEqual(result.results, []);
  assert.deepEqual(weekly.created, []);
  assert.deepEqual(calls, []);
});

test('the unprocessed listing is invalidated before the tracks are written', async (t) => {
  const { ports, calls } = memoryPorts(alphaCatalog(), [
    { id: 'pl-last', name: LAST_FRIDAY, trackCount: 3 },
  ]);
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);

  await runFill(w.options());

  assert.deepEqual(calls, [`create ${THIS_FRIDAY}`, 'invalidate', 'add pl-1']);
});

// ── Resume ───────────────────────────────────────────────────────────────────

/** Alpha (album) and Beta (single), both P1; Alpha outscores Beta. */
function alphaBetaCatalog(): Catalog {
  const catalog = alphaCatalog();
  catalog.artists.push({
    id: 'art-b',
    name: 'Beta',
    albums: [
      {
        id: 'alb-y',
        name: 'Y',
        type: 'single',
        release_date: IN_WINDOW,
        tracks: [{ id: 't2', name: 'Two', key: 'beta::two' }],
      },
    ],
  });
  return catalog;
}

const ALPHA_BETA_P1 = trusted({
  Alpha: { priority: 1, score: 100 },
  Beta: { priority: 1, score: 90 },
});

test('a fill resumes a checkpointed week: searched artists are skipped and reported', async (t) => {
  const { ports, reads, weekly, checkpoints } = memoryPorts(
    alphaBetaCatalog(),
    [{ id: 'pl-last', name: LAST_FRIDAY, trackCount: 3 }],
  );
  checkpoints.current = {
    week: THIS_FRIDAY,
    artistsSearched: 1,
    foundReleases: {},
  };
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_BETA_P1);
  const resumed: Array<[string | undefined, string[]]> = [];

  await runFill(
    w.options({
      handlers: {
        onResumed: (date, names) => resumed.push([date, names]),
      } as EventHandlers<PlaylistFillerEventMap>,
    }),
  );

  assert.deepEqual(resumed, [[THIS_FRIDAY, ['Alpha']]]);
  assert.deepEqual(reads.searchCalls, ['Beta']);
  assert.deepEqual(weekly.added.get('pl-1'), ['t2']);
});

test('a checkpointed week keeps the roster it started with: no mid-search recalculation', async (t) => {
  const { ports, calls, weekly, checkpoints } = memoryPorts(
    alphaBetaCatalog(),
    [{ id: 'pl-last', name: LAST_FRIDAY, trackCount: 3 }],
  );
  checkpoints.current = {
    week: THIS_FRIDAY,
    artistsSearched: 1,
    foundReleases: {},
  };
  const w = memoryWorld(t, ports);
  // Both sources changed since the roster was scored: a re-score is due.
  await w.cache.save(TRUSTED_ARTISTS, ALPHA_BETA_P1);
  await w.cache.save(RECALCULATION_STATE, {
    allWeeklySnapshot: 'aw-0',
    bestOfAllWeeklySnapshot: 'boaw-0',
  });

  await runFill(w.options());

  assert.ok(!calls.includes('scan'), 'the sources were re-scanned mid-search');
  assert.deepEqual(weekly.added.get('pl-1'), ['t2']);
});

test('--fresh drops the checkpoint: every artist is searched again', async (t) => {
  const { ports, reads, weekly, checkpoints } = memoryPorts(
    alphaBetaCatalog(),
    [{ id: 'pl-last', name: LAST_FRIDAY, trackCount: 3 }],
  );
  checkpoints.current = {
    week: THIS_FRIDAY,
    artistsSearched: 1,
    foundReleases: {},
  };
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_BETA_P1);
  const resumed: unknown[] = [];

  await runFill(
    w.options({
      fresh: true,
      handlers: {
        onResumed: (...args) => resumed.push(args),
      } as EventHandlers<PlaylistFillerEventMap>,
    }),
  );

  assert.deepEqual(resumed, []);
  assert.deepEqual(reads.searchCalls, ['Alpha', 'Beta']);
  assert.deepEqual(weekly.added.get('pl-1'), ['t1', 't2']);
});
