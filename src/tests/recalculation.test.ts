import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fixtureGateway } from '../lib/spotify/fixture.js';
import type { SimplePlaylist } from '../lib/types.js';
import { DEFAULT_USER_CONFIG, type UserConfig } from '../lib/user-config.js';
import {
  localUserData,
  PENDING_PRIORITY_CHANGES,
  RECALCULATION_STATE,
  TRUSTED_ARTISTS,
  type UserData,
} from '../lib/user-data/index.js';
import type { UserSession } from '../lib/user-session.js';
import type { PlaylistTrackWithArtists } from '../services/promotion-sync/index.js';
import {
  describeRecalculation,
  describeRecalculationResult,
  describeSync,
} from '../services/recalculation/describe.js';
import {
  type RecalculateOptions,
  type RecalculationPorts,
  type RecalculationProgress,
  recalculate,
  type SyncProgress,
  syncPending,
} from '../services/recalculation/index.js';
import { fixedPopularitySource } from '../services/week-collection/adapters.js';
import type { ReleaseReads } from '../services/week-collection/index.js';
import {
  LIKED_SONGS,
  type MemoryTrack,
  memoryPlaylists,
} from './fixtures/memory-playlists.js';

// ── Fixture: the source and weekly playlists ────────────────────────────────
// Each artist appears `count` times as primary, all at the very end of the
// playlist (the last tenth of it) — so an AW-only artist scores
// `2 * count + 20` under the default weights: 1 → 22 (P3), 3 → 26 (P2),
// 20 → 60 (P1).

type Plays = Record<string, number>;

function sourceTracks(plays: Plays): MemoryTrack[] {
  const played = Object.entries(plays).flatMap(([name, count]) =>
    Array.from({ length: count }, (_, i) => ({
      id: `${name}-${i}`,
      artistNames: [name],
    })),
  );
  const filler = Array.from({ length: played.length * 9 || 10 }, (_, i) => ({
    id: `filler-${i}`,
  }));
  return [...filler, ...played];
}

type WeeklyTrack = Omit<PlaylistTrackWithArtists, 'uri'>;

/**
 * All Weekly, BoAW and the unprocessed weekly playlists, in one set of
 * in-memory playlists: what promotion sync removes, the next read sees.
 */
function fixtureWorld(initial: {
  aw: Plays;
  boaw?: Plays;
  weeklies?: Array<{ id: string; tracks: WeeklyTrack[] }>;
}) {
  const weeklies = initial.weeklies ?? [];
  const playlists = memoryPlaylists([
    { id: 'aw', tracks: sourceTracks(initial.aw) },
    { id: 'boaw', tracks: sourceTracks(initial.boaw ?? {}) },
    ...weeklies.map((w) => ({ id: w.id, name: w.id, tracks: w.tracks })),
  ]);
  let failWrites = false;
  const ports: RecalculationPorts = {
    playlists: playlists.reads,
    unprocessed: {
      async find() {
        return {
          playlists: weeklies.map(
            (w): SimplePlaylist => ({
              id: w.id,
              name: w.id,
              trackCount: playlists.trackIds(w.id).length,
            }),
          ),
          awTrackIds: new Set<string>(),
        };
      },
    },
    sync: {
      reads: noReleaseReads,
      playlists: playlists.reads,
      popularity: fixedPopularitySource({}),
      writes: {
        addTracks: playlists.writes.addTracks,
        async removeTracks(playlistId, trackIds) {
          if (failWrites) throw new Error('spotify 500');
          await playlists.writes.removeTracks(playlistId, trackIds);
        },
      },
    },
  };
  return {
    ports,
    playlists,
    /** How many times each source's items were fetched. */
    scans() {
      const reads = playlists.trackReads;
      return {
        aw: reads.filter((id) => id === 'aw').length,
        boaw: reads.filter((id) => id === 'boaw').length,
      };
    },
    setAw(plays: Plays) {
      playlists.edit('aw', sourceTracks(plays));
    },
    failWrites(fail: boolean) {
      failWrites = fail;
    },
  };
}

/** Demotion-only scenarios: the addition phase never reads releases. */
const noReleaseReads: ReleaseReads = {
  async searchArtist() {
    return null;
  },
  async searchByUpc() {
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
};

function tmpCache(t: { after: (fn: () => void) => void }): {
  cache: UserData;
  dir: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recalculation-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    cache: localUserData(dir),
    dir,
  };
}

function setup(
  t: { after: (fn: () => void) => void },
  world: ReturnType<typeof fixtureWorld>,
) {
  const { cache, dir } = tmpCache(t);
  const deps: Deps = {
    // The fixture ports make every Spotify read, so the gateway is never called.
    session: { gateway: unusedGateway, userId: 'user-1', data: cache },
    ports: world.ports,
  };
  return { deps, cache, dir };
}

interface Deps {
  session: UserSession;
  ports: RecalculationPorts;
}

const unusedGateway = fixtureGateway({});

/** `recalculate` for the fixture session, with `config` saved first. */
async function recalc(
  config: UserConfig,
  deps: Deps,
  opts?: RecalculateOptions,
) {
  await deps.session.data.config.save(config);
  return recalculate(deps.session, opts, deps.ports);
}

/** `syncPending` for the fixture session, with `config` saved first. */
async function syncNow(
  config: UserConfig,
  deps: Deps,
  onProgress?: (e: SyncProgress) => void,
) {
  await deps.session.data.config.save(config);
  return syncPending(deps.session, onProgress, deps.ports);
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
  const world = fixtureWorld({ aw: { Steady: 3 } });
  const { deps } = setup(t, world);

  const result = await recalc(config(), deps);

  assert.equal(result.outcome, 'recalculated');
  assert.deepEqual(world.scans(), { aw: 1, boaw: 1 });
  assert.equal(priorityOf(result, 'Steady'), 2);
  // No prior roster to compare against: a baseline, not a crossing.
  assert.deepEqual(result.pending, []);
});

test('unchanged snapshots skip the scan and leave nothing pending', async (t) => {
  const world = fixtureWorld({ aw: { Steady: 3 } });
  const { deps } = setup(t, world);
  await recalc(config(), deps);

  const result = await recalc(config(), deps);

  assert.equal(result.outcome, 'unchanged');
  assert.deepEqual(world.scans(), { aw: 1, boaw: 1 });
  assert.equal(priorityOf(result, 'Steady'), 2);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.pending, []);
});

test('only the source whose snapshot moved is re-scanned', async (t) => {
  const world = fixtureWorld({ aw: { Steady: 3 }, boaw: { Loved: 5 } });
  const { deps } = setup(t, world);
  await recalc(config(), deps);

  world.setAw({ Steady: 3, Newcomer: 1 });
  const result = await recalc(config(), deps);

  assert.equal(result.outcome, 'recalculated');
  assert.deepEqual(world.scans(), { aw: 2, boaw: 1 });
  assert.equal(priorityOf(result, 'Loved'), 2); // from the reused BoAW scan
});

test('the user’s thresholds decide the tiers, not the defaults', async (t) => {
  const world = fixtureWorld({ aw: { Steady: 3 } }); // score 26
  const { deps } = setup(t, world);

  const result = await recalc(
    config({ priorityThresholds: { p1: 90, p2: 50, p3: 20, p4: 1 } }),
    deps,
  );

  assert.equal(priorityOf(result, 'Steady'), 3);
});

test('a P2 → P3 crossing is pending until promotion sync removes its album', async (t) => {
  const world = fixtureWorld({
    aw: { Fading: 3, Anchor: 20 },
    weeklies: [
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
    ],
  });
  const { deps } = setup(t, world);
  await recalc(config(), deps);

  world.setAw({ Fading: 1, Anchor: 20 });
  const result = await recalc(config(), deps);

  assert.deepEqual(result.changes, [{ artist: 'Fading', from: 2, to: 3 }]);
  assert.deepEqual(result.pending, [{ artist: 'Fading', from: 2, to: 3 }]);
  assert.deepEqual(
    describeRecalculationResult(result)
      .slice(1)
      .map((l) => l.message),
    [
      '1 artist(s) changed priority:',
      '  P2 → P3: Fading',
      'Priorities recalculated and saved',
    ],
  );

  const lines: string[] = [];
  const sync = await syncNow(config(), deps, (e) => {
    for (const l of describeSync(e)) lines.push(l.message);
  });

  assert.equal(sync?.removed, 1);
  assert.deepEqual(world.playlists.removed.get('pl-1'), ['fading-1']);
  // Each playlist's removals, and the result exactly once.
  assert.ok(
    lines.includes('  Synced "pl-1": −1 +0 (removed Fading)'),
    String(lines),
  );
  assert.equal(lines.filter((l) => /sync complete/i.test(l)).length, 1);
  assert.equal(await syncNow(config(), deps), null); // cleared
});

test('a failed sync stays pending and the next sync applies it', async (t) => {
  const world = fixtureWorld({
    aw: { Fading: 3 },
    weeklies: [
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
    ],
  });
  const { deps, cache } = setup(t, world);
  await recalc(config(), deps);
  world.setAw({ Fading: 1 });
  await recalc(config(), deps);

  world.failWrites(true);
  await assert.rejects(syncNow(config(), deps), /spotify 500/);
  assert.deepEqual(await cache.load(PENDING_PRIORITY_CHANGES), [
    { artist: 'Fading', from: 2, to: 3 },
  ]);

  world.failWrites(false);
  const sync = await syncNow(config(), deps);

  assert.equal(sync?.removed, 1);
  assert.equal(await cache.load(PENDING_PRIORITY_CHANGES), null);
});

test('a promotion undone before any sync nets out to nothing pending', async (t) => {
  const world = fixtureWorld({ aw: { Flicker: 1 } }); // P3
  const { deps } = setup(t, world);
  await recalc(config(), deps);

  world.setAw({ Flicker: 3 }); // P2
  const promoted = await recalc(config(), deps);
  assert.deepEqual(promoted.pending, [{ artist: 'Flicker', from: 3, to: 2 }]);

  world.setAw({ Flicker: 1 }); // P3 again
  const undone = await recalc(config(), deps);

  assert.deepEqual(undone.changes, [{ artist: 'Flicker', from: 2, to: 3 }]);
  assert.deepEqual(undone.pending, []);
});

test('an unchanged run says nothing about its scans', async (t) => {
  const world = fixtureWorld({ aw: { Steady: 3 } });
  const { deps } = setup(t, world);
  await recalc(config(), deps);

  const events: RecalculationProgress['phase'][] = [];
  await recalc(config(), deps, { onProgress: (e) => events.push(e.phase) });

  // Both sources were read (and their reads ended), but nothing re-scored.
  assert.deepEqual(events, ['scan-read', 'scan-read']);
});

test('a source read by someone else since the last recalculation still counts as changed', async (t) => {
  const world = fixtureWorld({ aw: { Steady: 3 } });
  const { deps } = setup(t, world);
  await recalc(config(), deps);

  world.setAw({ Steady: 3, Newcomer: 1 });
  // e.g. the unprocessed listing reads All Weekly first, so it's held.
  await world.playlists.reads.tracks('aw');
  const result = await recalc(config(), deps);

  assert.equal(result.outcome, 'recalculated');
  assert.equal(priorityOf(result, 'Newcomer'), 3);
});

test('a short read is scored but not recorded, so the next run scores it again', async (t) => {
  const world = fixtureWorld({ aw: { Steady: 3 } });
  const { deps, cache } = setup(t, world);
  world.playlists.short('aw', 2);

  const lines: string[] = [];
  const first = await recalc(config(), deps, {
    onProgress: (e) => {
      for (const l of describeRecalculation(e)) lines.push(l.message);
    },
  });
  assert.equal(first.outcome, 'recalculated');
  assert.ok(
    lines.includes(
      'All Weekly: Spotify left out 2 track(s); scored again next recalculation',
    ),
    String(lines),
  );
  assert.equal(
    (await cache.load(RECALCULATION_STATE))?.allWeeklySnapshot,
    undefined,
  );

  const second = await recalc(config(), deps);

  assert.equal(second.outcome, 'recalculated');
  assert.equal(priorityOf(second, 'Steady'), 2);
  const third = await recalc(config(), deps);
  assert.equal(third.outcome, 'unchanged');
});

test('a failed source read fails the recalculation and keeps the roster', async (t) => {
  const world = fixtureWorld({ aw: { Steady: 3 } });
  const { deps, cache } = setup(t, world);
  const before = await recalc(config(), deps);

  world.setAw({ Steady: 20 });
  world.playlists.fail('aw', new Error('spotify 502'));

  await assert.rejects(recalc(config(), deps), /spotify 502/);
  assert.deepEqual(await cache.load(TRUSTED_ARTISTS), before.roster);
});

test('Liked Songs as the second source is read newest first', async (t) => {
  const world = fixtureWorld({ aw: { Steady: 3 } });
  const { deps } = setup(t, world);
  // Liked Songs lists the newest like first: Recent was liked last.
  world.playlists.edit(LIKED_SONGS, [
    { id: 'r1', artistNames: ['Recent'] },
    ...Array.from({ length: 9 }, (_, i) => `filler-${i}`),
    { id: 'o1', artistNames: ['Old'] },
  ]);
  const liked = config();
  liked.sourcePlaylists = { ...liked.sourcePlaylists, useLikedSongs: true };

  const result = await recalc(liked, deps);

  const recent = result.roster.artistCounts.Recent;
  const old = result.roster.artistCounts.Old;
  assert.ok(recent && old);
  assert.ok(recent.recencyBonusBoAW > old.recencyBonusBoAW);
  assert.deepEqual(world.scans(), { aw: 1, boaw: 0 });
});
