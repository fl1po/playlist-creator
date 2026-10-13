import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { formatDateISO, formatDdMmYy } from '../domain/tracks.js';
import {
  AI_PICKS,
  PENDING_PRIORITY_CHANGES,
  RECALCULATION_STATE,
  TRUSTED_ARTISTS,
} from '../lib/cache-files.js';
import { createDurableCache, type DurableCache } from '../lib/durable-cache.js';
import type { EventHandlers } from '../lib/service-events.js';
import { fixtureGateway } from '../lib/spotify/fixture.js';
import { type SpotifyGateway, TaskAborted } from '../lib/spotify/gateway.js';
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
  fixtureCandidates,
  fixtureJudge,
  memoryCheckpoints,
} from '../services/week-collection/adapters.js';
import type {
  AiPicksRecord,
  Candidate,
  TasteJudgeOutcome,
  TasteJudgeRequest,
} from '../services/week-collection/index.js';
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

// ── Fixture: fake SpotifyGateway ────────────────────────────────────────────

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

function fixtureCtx(world: FixtureWorld): SpotifyGateway & {
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

  return { ...fixtureGateway(api), removed };
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
  ctx: SpotifyGateway,
  sources?: SourceReads,
) {
  const dataDir = tmpDataDir(t);
  const cache = createDurableCache({ userId: 'user-1', dataDir, redis: null });
  const storage = memoryStorage();
  const ports = fillPorts(ctx, { userId: 'user-1', dataDir, storage, cache });
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
        aiFindsAvailable: false,
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
  const abortError = new TaskAborted();
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
  const abortError = new TaskAborted();

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
      cache: first.cache,
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
        aiFindsAvailable: false,
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

test('the checkpoint is cleared once the weekly playlist is written', async (t) => {
  const { ports, checkpoints } = memoryPorts(alphaCatalog(), [
    { id: 'pl-last', name: LAST_FRIDAY, trackCount: 3 },
  ]);
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);

  await runFill(w.options());

  assert.equal(checkpoints.current, null);
});

test('a failed write leaves the completed search checkpoint in place', async (t) => {
  const { ports, weekly, checkpoints } = memoryPorts(alphaCatalog(), [
    { id: 'pl-last', name: LAST_FRIDAY, trackCount: 3 },
  ]);
  weekly.failAddWith = new Error('rate limited');
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);

  await runFill(w.options());

  assert.equal(checkpoints.current?.week, THIS_FRIDAY);
  assert.equal(checkpoints.current?.artistsSearched, 1);
  assert.deepEqual(Object.keys(checkpoints.current?.foundReleases ?? {}), [
    'alb-x',
  ]);
});

test('a completed checkpoint resumes the week with no search and no recalculation', async (t) => {
  const { ports, reads, calls, weekly, checkpoints } = memoryPorts(
    alphaBetaCatalog(),
    [{ id: 'pl-last', name: LAST_FRIDAY, trackCount: 3 }],
  );
  checkpoints.current = {
    week: THIS_FRIDAY,
    artistsSearched: 2,
    foundReleases: {
      'alb-x': {
        id: 'alb-x',
        name: 'X',
        type: 'album',
        release_date: IN_WINDOW,
        artistName: 'Alpha',
        artistSpotifyId: 'art-a',
        priority: 1,
        score: 100,
      },
      'alb-y': {
        id: 'alb-y',
        name: 'Y',
        type: 'single',
        release_date: IN_WINDOW,
        artistName: 'Beta',
        artistSpotifyId: 'art-b',
        priority: 1,
        score: 90,
      },
    },
  };
  const w = memoryWorld(t, ports);
  // Both sources changed since the roster was scored: a re-score would be due.
  await w.cache.save(TRUSTED_ARTISTS, ALPHA_BETA_P1);
  await w.cache.save(RECALCULATION_STATE, {
    allWeeklySnapshot: 'aw-0',
    bestOfAllWeeklySnapshot: 'boaw-0',
  });

  await runFill(w.options());

  assert.deepEqual(reads.searchCalls, []);
  assert.ok(!calls.includes('scan'), 'the sources were re-scanned');
  assert.deepEqual(weekly.added.get('pl-1'), ['t1', 't2']);
  assert.equal(checkpoints.current, null);
});

test('--fresh drops a completed checkpoint too', async (t) => {
  const { ports, reads, checkpoints } = memoryPorts(alphaBetaCatalog(), [
    { id: 'pl-last', name: LAST_FRIDAY, trackCount: 3 },
  ]);
  checkpoints.current = {
    week: THIS_FRIDAY,
    artistsSearched: 2,
    foundReleases: {},
  };
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_BETA_P1);

  await runFill(w.options({ fresh: true }));

  assert.deepEqual(reads.searchCalls, ['Alpha', 'Beta']);
});

// ── AI finds ─────────────────────────────────────────────────────────────────
// The fill drives the AI phase week to week: the spend ceiling, the AI-picks
// record beside each weekly playlist, and the Live Log lines.

const TWO_FRIDAYS_AGO = formatDdMmYy(
  new Date(mostRecentFriday(new Date()).getTime() - 14 * 86_400_000),
);
const LAST_IN_WINDOW = formatDateISO(
  new Date(mostRecentFriday(new Date()).getTime() - 7 * 86_400_000),
);

const AI_ON: UserConfig = {
  ...USER_CONFIG,
  aiFinds: { enabled: true, threshold: 50, scoutingPlaylists: [] },
};

/** Alpha (P1) plus Gamma, off the roster, with a single in each window. */
function aiCatalog(): Catalog {
  const catalog = alphaCatalog();
  catalog.artists.push({
    id: 'art-g',
    name: 'Gamma',
    albums: [
      {
        id: 'alb-g',
        name: 'G',
        type: 'single',
        release_date: IN_WINDOW,
        tracks: [{ id: 'tg', name: 'Gee', key: 'gamma::gee' }],
      },
      {
        id: 'alb-g0',
        name: 'G0',
        type: 'single',
        release_date: LAST_IN_WINDOW,
        tracks: [{ id: 'tg0', name: 'Gee Zero', key: 'gamma::gee0' }],
      },
    ],
  });
  return catalog;
}

/** Gamma's release, known to Spotify by album id. */
function gammaCandidate(
  id: string,
  album: { id: string; title: string; date: string },
): Candidate {
  return {
    id,
    title: album.title,
    artist: 'Gamma',
    type: 'single',
    trackCount: 1,
    releaseDate: album.date,
    genres: [],
    artistFans: 1000,
    upc: null,
    relativePopularity: 1,
    provenance: [{ kind: 'related', to: ['Alpha'] }],
    spotifyAlbumId: album.id,
  };
}

const PICK_G: TasteJudgeOutcome = {
  ok: true,
  picks: [{ id: 'c-g', confidence: 80, reason: 'close to Alpha' }],
  spendUsd: 0.05,
};

/** The week's record when PICK_G lands. */
const PICK_RECORD_G: AiPicksRecord = {
  picks: [
    {
      albumId: 'alb-g',
      artist: 'Gamma',
      title: 'G',
      confidence: 80,
      reason: 'close to Alpha',
    },
  ],
};

/** Memory fill ports with fixture AI ports on the week. */
function aiPorts(
  outcome: TasteJudgeOutcome | ((r: TasteJudgeRequest) => TasteJudgeOutcome),
  weeklies: SimplePlaylist[] = [
    { id: 'pl-last', name: LAST_FRIDAY, trackCount: 3 },
  ],
) {
  const m = memoryPorts(aiCatalog(), weeklies);
  const candidates = fixtureCandidates([
    gammaCandidate('c-g', { id: 'alb-g', title: 'G', date: IN_WINDOW }),
    gammaCandidate('c-g0', { id: 'alb-g0', title: 'G0', date: IN_WINDOW }),
  ]);
  const judge = fixtureJudge(outcome);
  // The week count of each fill the AI ports were built for.
  const builtFor: number[] = [];
  m.ports.ai = ({ weeks }) => {
    builtFor.push(weeks);
    return { candidates, judge };
  };
  return { ...m, candidates, judge, builtFor };
}

/** Log and warning lines, in order. */
function recordingLog() {
  const lines: string[] = [];
  const handlers = {
    onLog: (msg) => lines.push(msg),
    onWarning: (msg) => lines.push(`warn: ${msg}`),
  } as EventHandlers<PlaylistFillerEventMap>;
  return { lines, handlers };
}

const aiLines = (lines: string[]) => lines.filter((l) => /\bAI\b/.test(l));

test('an opted-in week keeps its AI picks beside the weekly playlist', async (t) => {
  const { ports, weekly } = aiPorts(PICK_G);
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);

  await runFill(w.options({ userConfig: AI_ON, aiFindsAvailable: true }));

  assert.deepEqual(weekly.added.get('pl-1'), ['t1', 'tg']);
  assert.deepEqual(await w.cache.load(AI_PICKS), {
    [THIS_FRIDAY]: PICK_RECORD_G,
  });
});

test('the AI ports are built once per fill, for its week count', async (t) => {
  const { ports, judge, builtFor } = aiPorts(PICK_G, [
    { id: 'pl-old', name: TWO_FRIDAYS_AGO, trackCount: 3 },
  ]);
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);

  await runFill(w.options({ userConfig: AI_ON, aiFindsAvailable: true }));

  assert.deepEqual(builtFor, [2]);
  assert.equal(judge.requests.length, 2);
});

test('the production fill ports build the Deezer source and the Claude judge', (t) => {
  const dataDir = tmpDataDir(t);
  const ports = fillPorts(fixtureCtx({ userId: 'user-1' }), {
    userId: 'user-1',
    dataDir,
    storage: memoryStorage(),
    cache: createDurableCache({ userId: 'user-1', dataDir, redis: null }),
  });

  const ai = ports.ai?.({ weeks: 1 });

  assert.equal(typeof ai?.candidates.candidates, 'function');
  assert.equal(typeof ai?.judge.judge, 'function');
});

test('a user who has not opted in gets no AI input, record or log lines', async (t) => {
  const { ports, judge, candidates, builtFor } = aiPorts(PICK_G);
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);
  const log = recordingLog();

  await runFill(w.options({ aiFindsAvailable: true, handlers: log.handlers }));

  assert.deepEqual(builtFor, []);
  assert.equal(candidates.requests.length, 0);
  assert.equal(judge.requests.length, 0);
  assert.equal(await w.cache.load(AI_PICKS), null);
  assert.deepEqual(aiLines(log.lines), []);
});

test('opted in on a server with no API key: the week is recorded no-api-key', async (t) => {
  const { ports, judge, weekly } = aiPorts(PICK_G);
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);

  await runFill(w.options({ userConfig: AI_ON, aiFindsAvailable: false }));

  assert.equal(judge.requests.length, 0);
  assert.deepEqual(weekly.added.get('pl-1'), ['t1']);
  assert.deepEqual(await w.cache.load(AI_PICKS), {
    [THIS_FRIDAY]: { skipped: 'no-api-key' },
  });
});

test('a failed write leaves no AI-picks record', async (t) => {
  const { ports, weekly } = aiPorts(PICK_G);
  weekly.failAddWith = new Error('rate limited');
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);

  await runFill(w.options({ userConfig: AI_ON, aiFindsAvailable: true }));

  assert.equal(await w.cache.load(AI_PICKS), null);
});

test('the spend ceiling carries from week to week and is fresh on each fill', async (t) => {
  const outcome: TasteJudgeOutcome = { ok: true, picks: [], spendUsd: 0.75 };
  const first = aiPorts(outcome, [
    { id: 'pl-old', name: TWO_FRIDAYS_AGO, trackCount: 3 },
  ]);
  const w = memoryWorld(t, first.ports);
  await seedRoster(w.cache, ALPHA_P1);

  await runFill(w.options({ userConfig: AI_ON, aiFindsAvailable: true }));

  assert.deepEqual(
    first.judge.requests.map((r) => r.budgetUsd),
    [1, 0.25],
  );

  const second = aiPorts(outcome);
  await runFill(
    w.options({
      userConfig: AI_ON,
      aiFindsAvailable: true,
      ports: second.ports,
    }),
  );

  assert.deepEqual(
    second.judge.requests.map((r) => r.budgetUsd),
    [1],
  );
});

test('weeks after the ceiling is spent are recorded over-budget without a judge call', async (t) => {
  const { ports, judge } = aiPorts({ ok: true, picks: [], spendUsd: 1.1 }, [
    { id: 'pl-old', name: TWO_FRIDAYS_AGO, trackCount: 3 },
  ]);
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);

  await runFill(w.options({ userConfig: AI_ON, aiFindsAvailable: true }));

  assert.equal(judge.requests.length, 1);
  assert.deepEqual(await w.cache.load(AI_PICKS), {
    [LAST_FRIDAY]: { picks: [] },
    [THIS_FRIDAY]: { skipped: 'over-budget' },
  });
});

test('after the spend cap, later weeks are recorded over-budget', async (t) => {
  const { ports, judge } = aiPorts(
    { ok: false, failure: 'spend-cap', spendUsd: 0.01 },
    [{ id: 'pl-old', name: TWO_FRIDAYS_AGO, trackCount: 3 }],
  );
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);

  await runFill(w.options({ userConfig: AI_ON, aiFindsAvailable: true }));

  assert.equal(judge.requests.length, 1);
  assert.deepEqual(await w.cache.load(AI_PICKS), {
    [LAST_FRIDAY]: { skipped: 'failed' },
    [THIS_FRIDAY]: { skipped: 'over-budget' },
  });
});

test('a stop in the AI phase leaves no record; the resume skips the search and asks the judge again', async (t) => {
  let calls = 0;
  const { ports, reads, judge, weekly } = aiPorts(() => {
    calls++;
    if (calls === 1) throw new TaskAborted();
    return PICK_G;
  });
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);
  const options = w.options({ userConfig: AI_ON, aiFindsAvailable: true });

  await assert.rejects(runFill(options), /Stopped/);
  assert.equal(await w.cache.load(AI_PICKS), null);
  assert.deepEqual(weekly.created, []);

  reads.searchCalls.length = 0;
  await runFill(options);

  assert.deepEqual(reads.searchCalls, []);
  assert.equal(judge.requests.length, 2);
  assert.deepEqual(weekly.added.get('pl-1'), ['t1', 'tg']);
  assert.deepEqual(
    (await w.cache.load(AI_PICKS))?.[THIS_FRIDAY],
    PICK_RECORD_G,
  );
});

test("a rebuilt empty Friday replaces that week's AI-picks record", async (t) => {
  const { ports } = aiPorts(PICK_G, [
    { id: 'pl-empty', name: THIS_FRIDAY, trackCount: 0 },
  ]);
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);
  await w.cache.save(AI_PICKS, {
    [THIS_FRIDAY]: { skipped: 'failed' },
    [LAST_FRIDAY]: { skipped: 'over-budget' },
  });

  await runFill(w.options({ userConfig: AI_ON, aiFindsAvailable: true }));

  assert.deepEqual(await w.cache.load(AI_PICKS), {
    [THIS_FRIDAY]: PICK_RECORD_G,
    [LAST_FRIDAY]: { skipped: 'over-budget' },
  });
});

test('the Live Log shows each pick, a warning per skip, and the summary with cost', async (t) => {
  const { ports } = aiPorts({
    ok: true,
    picks: [
      { id: 'c-g', confidence: 80, reason: 'close to Alpha' },
      { id: 'c-g0', confidence: 70, reason: 'from last week' },
    ],
    spendUsd: 0.0612,
  });
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);
  const log = recordingLog();

  await runFill(
    w.options({
      userConfig: AI_ON,
      aiFindsAvailable: true,
      handlers: log.handlers,
    }),
  );

  assert.deepEqual(aiLines(log.lines), [
    'warn: AI pick skipped (not on Spotify): Gamma — G0',
    'AI pick: Gamma — G (80) — close to Alpha',
    'AI finds: 1 picks from 2 candidates, $0.06',
  ]);
});

test('the Live Log counts the related-artist top-up and sums up failed seeds', async (t) => {
  const { ports, candidates } = aiPorts(PICK_G);
  const inner = candidates.candidates.bind(candidates);
  candidates.candidates = async (request, onProgress) => {
    for (let done = 0; done <= 30; done++) {
      onProgress?.({ phase: 'related-artists', done, total: 30 });
    }
    onProgress?.({ phase: 'related-artists-failed', seeds: 2 });
    return inner(request, onProgress);
  };
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);
  const log = recordingLog();

  await runFill(
    w.options({
      userConfig: AI_ON,
      aiFindsAvailable: true,
      handlers: log.handlers,
    }),
  );

  assert.deepEqual(
    log.lines.filter((l) => l.includes('Related artists')),
    [
      'Related artists: 0/30',
      'Related artists: 25/30',
      'Related artists: 30/30',
      'warn: Related artists: 2 seeds unresolved/failed',
    ],
  );
});

test('a skipped week logs its reason as a warning', async (t) => {
  const { ports } = aiPorts({
    ok: false,
    failure: 'failed',
    message: 'timed out',
    spendUsd: 0,
  });
  const w = memoryWorld(t, ports);
  await seedRoster(w.cache, ALPHA_P1);
  const log = recordingLog();

  await runFill(
    w.options({
      userConfig: AI_ON,
      aiFindsAvailable: true,
      handlers: log.handlers,
    }),
  );

  assert.deepEqual(aiLines(log.lines), [
    'warn: AI finds skipped (failed): timed out',
    'AI finds: 0 picks from 2 candidates, $0.00',
  ]);
});
