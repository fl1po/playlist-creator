import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  BATCH_CACHE,
  PENDING_PRIORITY_CHANGES,
  TRUSTED_ARTISTS,
} from '../lib/cache-files.js';
import { type DurableCache, createDurableCache } from '../lib/durable-cache.js';
import type { PlaylistTrackWithArtists } from '../lib/pagination.js';
import {
  type PlaylistScanResult,
  type SimplePlaylist,
  toCachedScanResult,
} from '../lib/types.js';
import { DEFAULT_USER_CONFIG, type UserConfig } from '../lib/user-config.js';
import type { PlaylistWrites } from '../services/promotion-sync/index.js';
import {
  type RecalculationDeps,
  type Source,
  type SourceReads,
  recalculate,
  syncPending,
} from '../services/recalculation/index.js';
import { fixedPopularitySource } from '../services/week-collection/adapters.js';

// ── Fixture: the two source playlists ───────────────────────────────────────
// Each artist appears `count` times as primary, most recently at the very end
// of the playlist — so an AW-only artist scores `2 * count + 20` under the
// default weights: 1 → 22 (P3), 3 → 26 (P2), 20 → 60 (P1).

type Plays = Record<string, number>;

function scanOf(plays: Plays): PlaylistScanResult {
  const total = Math.max(1, ...Object.values(plays)) * 10;
  return {
    artistData: new Map(
      Object.entries(plays).map(([name, count]) => [
        name,
        {
          primaryCount: count,
          featuredCount: 0,
          latestPosition: total,
          featuredAtLatest: false,
          id: null,
        },
      ]),
    ),
    totalTracks: total,
  };
}

/** Mutable source playlists; bump a snapshot id by changing its plays. */
function fixtureSources(initial: { aw: Plays; boaw?: Plays }) {
  const world = {
    aw: initial.aw,
    boaw: initial.boaw ?? {},
    awVersion: 1,
    boawVersion: 1,
    scans: { aw: 0, boaw: 0 },
  };
  const reads: SourceReads = {
    async snapshots() {
      return { aw: `aw-${world.awVersion}`, boaw: `boaw-${world.boawVersion}` };
    },
    async scan(source: Source) {
      world.scans[source]++;
      return scanOf(world[source]);
    },
  };
  return {
    reads,
    world,
    setAw(plays: Plays) {
      world.aw = plays;
      world.awVersion++;
    },
  };
}

// ── Fixture: the unprocessed weekly playlists promotion sync reconciles ─────

type WeeklyTrack = Omit<PlaylistTrackWithArtists, 'uri'>;

function fixtureWeeklies(input: Array<{ id: string; tracks: WeeklyTrack[] }>) {
  const playlists = input.map((p) => ({
    id: p.id,
    tracks: p.tracks.map((t) => ({ ...t, uri: `spotify:track:${t.id}` })),
  }));
  const removed: Record<string, string[]> = {};
  let failWrites = false;
  const writes: PlaylistWrites = {
    async addTracks() {},
    async removeTracks(playlistId, trackIds) {
      if (failWrites) throw new Error('spotify 500');
      removed[playlistId] = [...(removed[playlistId] ?? []), ...trackIds];
      for (const pl of playlists) {
        if (pl.id === playlistId)
          pl.tracks = pl.tracks.filter((t) => !trackIds.includes(t.id));
      }
    },
  };
  return {
    removed,
    failWrites(fail: boolean) {
      failWrites = fail;
    },
    unprocessed: {
      async find() {
        return {
          playlists: playlists.map(
            (p) =>
              ({
                id: p.id,
                name: p.id,
                trackCount: p.tracks.length,
              }) as SimplePlaylist,
          ),
          awTrackIds: new Set<string>(),
        };
      },
      async invalidate() {},
    },
    sync: {
      reads: {
        // Demotion-only scenarios: the addition phase never reads releases.
        async searchArtist() {
          return null;
        },
        async artistAlbums() {
          return [];
        },
        async albumDetails() {
          return null;
        },
        async albumTracks() {
          return [];
        },
        async playlistAlbums() {
          return new Map();
        },
        async userPlaylists() {
          return [];
        },
        async artistProfile() {
          return null;
        },
        async playlistTracksWithArtists(id: string) {
          return playlists.find((p) => p.id === id)?.tracks ?? [];
        },
        async playlistTrackIds(id: string) {
          return (playlists.find((p) => p.id === id)?.tracks ?? []).map(
            (t) => t.id,
          );
        },
      },
      popularity: fixedPopularitySource({}),
      writes,
    },
  };
}

function tmpCache(t: { after: (fn: () => void) => void }): {
  cache: DurableCache;
  dir: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recalculation-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    cache: createDurableCache({ userId: 'u', dataDir: dir, redis: null }),
    dir,
  };
}

function setup(
  t: { after: (fn: () => void) => void },
  sources: ReturnType<typeof fixtureSources>,
  weeklies = fixtureWeeklies([]),
) {
  const { cache, dir } = tmpCache(t);
  const deps: RecalculationDeps = {
    cache,
    ports: {
      sources: sources.reads,
      unprocessed: weeklies.unprocessed,
      sync: weeklies.sync,
    },
  };
  return { deps, cache, dir };
}

function config(overrides: Partial<UserConfig['scoring']> = {}): UserConfig {
  return {
    ...DEFAULT_USER_CONFIG,
    sourcePlaylists: {
      ...DEFAULT_USER_CONFIG.sourcePlaylists,
      allWeeklyId: 'aw',
      bestOfAllWeeklyId: 'boaw',
      useLikedSongs: false,
    },
    scoring: { ...DEFAULT_USER_CONFIG.scoring, ...overrides },
  };
}

const priorityOf = (
  result: Awaited<ReturnType<typeof recalculate>>,
  artist: string,
) => result.roster.artistCounts[artist]?.priority ?? null;

// ── Tests ────────────────────────────────────────────────────────────────────

test('a cold cache recalculates from scratch and records no pending changes', async (t) => {
  const sources = fixtureSources({ aw: { Steady: 3 } });
  const { deps } = setup(t, sources);

  const result = await recalculate(config(), deps);

  assert.equal(result.outcome, 'recalculated');
  assert.deepEqual(sources.world.scans, { aw: 1, boaw: 1 });
  assert.equal(priorityOf(result, 'Steady'), 2);
  // No prior roster to compare against: a baseline, not a crossing.
  assert.deepEqual(result.pending, []);
});

test('unchanged snapshots skip the scan and leave nothing pending', async (t) => {
  const sources = fixtureSources({ aw: { Steady: 3 } });
  const { deps } = setup(t, sources);
  await recalculate(config(), deps);

  const result = await recalculate(config(), deps);

  assert.equal(result.outcome, 'unchanged');
  assert.deepEqual(sources.world.scans, { aw: 1, boaw: 1 });
  assert.equal(priorityOf(result, 'Steady'), 2);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.pending, []);
});

test('only the source whose snapshot moved is re-scanned', async (t) => {
  const sources = fixtureSources({ aw: { Steady: 3 }, boaw: { Loved: 5 } });
  const { deps } = setup(t, sources);
  await recalculate(config(), deps);

  sources.setAw({ Steady: 3, Newcomer: 1 });
  const result = await recalculate(config(), deps);

  assert.equal(result.outcome, 'recalculated');
  assert.deepEqual(sources.world.scans, { aw: 2, boaw: 1 });
  assert.equal(priorityOf(result, 'Loved'), 2); // from the reused BoAW scan
});

test('the user’s thresholds decide the tiers, not the defaults', async (t) => {
  const sources = fixtureSources({ aw: { Steady: 3 } }); // score 26
  const { deps } = setup(t, sources);

  const result = await recalculate(
    config({ priorityThresholds: { p1: 90, p2: 50, p3: 20, p4: 1 } }),
    deps,
  );

  assert.equal(priorityOf(result, 'Steady'), 3);
});

test('a P2 → P3 crossing is pending until promotion sync removes its album', async (t) => {
  const sources = fixtureSources({ aw: { Fading: 3, Anchor: 20 } });
  const weeklies = fixtureWeeklies([
    {
      id: 'pl-1',
      tracks: [
        {
          id: 'fading-1',
          name: 'x',
          artistNames: ['Fading'],
          albumId: 'alb-1',
        },
        {
          id: 'anchor-1',
          name: 'y',
          artistNames: ['Anchor'],
          albumId: 'alb-2',
        },
      ],
    },
  ]);
  const { deps } = setup(t, sources, weeklies);
  await recalculate(config(), deps);

  sources.setAw({ Fading: 1, Anchor: 20 });
  const result = await recalculate(config(), deps);

  assert.deepEqual(result.changes, [{ artist: 'Fading', from: 2, to: 3 }]);
  assert.deepEqual(result.pending, [{ artist: 'Fading', from: 2, to: 3 }]);

  const sync = await syncPending(config(), deps);

  assert.equal(sync?.removed, 1);
  assert.deepEqual(weeklies.removed, { 'pl-1': ['fading-1'] });
  assert.equal(await syncPending(config(), deps), null); // cleared
});

test('a failed sync stays pending and the next sync applies it', async (t) => {
  const sources = fixtureSources({ aw: { Fading: 3 } });
  const weeklies = fixtureWeeklies([
    {
      id: 'pl-1',
      tracks: [
        {
          id: 'fading-1',
          name: 'x',
          artistNames: ['Fading'],
          albumId: 'alb-1',
        },
      ],
    },
  ]);
  const { deps, cache } = setup(t, sources, weeklies);
  await recalculate(config(), deps);
  sources.setAw({ Fading: 1 });
  await recalculate(config(), deps);

  weeklies.failWrites(true);
  await assert.rejects(syncPending(config(), deps), /spotify 500/);
  assert.deepEqual(await cache.load(PENDING_PRIORITY_CHANGES), [
    { artist: 'Fading', from: 2, to: 3 },
  ]);

  weeklies.failWrites(false);
  const sync = await syncPending(config(), deps);

  assert.equal(sync?.removed, 1);
  assert.equal(await cache.load(PENDING_PRIORITY_CHANGES), null);
});

test('a promotion undone before any sync nets out to nothing pending', async (t) => {
  const sources = fixtureSources({ aw: { Flicker: 1 } }); // P3
  const { deps } = setup(t, sources);
  await recalculate(config(), deps);

  sources.setAw({ Flicker: 3 }); // P2
  const promoted = await recalculate(config(), deps);
  assert.deepEqual(promoted.pending, [{ artist: 'Flicker', from: 3, to: 2 }]);

  sources.setAw({ Flicker: 1 }); // P3 again
  const undone = await recalculate(config(), deps);

  assert.deepEqual(undone.changes, [{ artist: 'Flicker', from: 2, to: 3 }]);
  assert.deepEqual(undone.pending, []);
});

test('state left in batch-cache.json by older versions is picked up once', async (t) => {
  const sources = fixtureSources({ aw: { Steady: 3 } });
  const first = await recalculate(config(), setup(t, sources).deps);
  // A second store in the pre-split layout: the roster, plus snapshots and
  // scans kept in the batch cache instead of recalculation's own state.
  const legacy = setup(t, sources);
  await legacy.cache.save(TRUSTED_ARTISTS, first.roster);
  await legacy.cache.save(BATCH_CACHE, {
    allWeeklySnapshot: 'aw-1',
    bestOfAllWeeklySnapshot: 'boaw-1',
    awScanCache: toCachedScanResult(scanOf({ Steady: 3 })),
    boawScanCache: toCachedScanResult(scanOf({})),
  });

  const result = await recalculate(config(), legacy.deps);

  assert.equal(result.outcome, 'unchanged');
  assert.deepEqual(sources.world.scans, { aw: 1, boaw: 1 }); // no new scans
});
