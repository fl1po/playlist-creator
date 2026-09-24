import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MIN_LASTFM_LISTENERS,
  applyFloor,
  scoreAcclaim,
} from '../services/year-collection/acclaim.js';
import {
  FailureLog,
  degradedPhases,
  emptyCheckpoint,
} from '../services/year-collection/checkpoint.js';
import { clusterOf } from '../services/year-collection/genre-map.js';
import { monthOf } from '../services/year-collection/plan.js';
import {
  type RawAlbum,
  selectYearReleases,
} from '../services/year-collection/releases.js';

// ── Genre clustering ─────────────────────────────────────────────────────────

test('clusters the roster vocabulary into the right scenes', () => {
  assert.equal(clusterOf('grime'), 'grime');
  assert.equal(clusterOf('uk drill'), 'drill');
  assert.equal(clusterOf('alternative r&b'), 'rnb-soul');
  assert.equal(clusterOf('trap soul'), 'rnb-soul');
  assert.equal(clusterOf('jazz rap'), 'us-rap');
});

test('alté clusters as afro despite the non-ASCII word boundary', () => {
  // /alté\b/ never matches: JS word boundaries are ASCII-only, so there is no
  // boundary after "é". This is the roster's third-largest Afro genre.
  assert.equal(clusterOf('alté'), 'afro');
  assert.equal(clusterOf('alte'), 'afro');
});

test('scene membership beats keyword for cross-scene genres', () => {
  assert.equal(clusterOf('nigerian drill'), 'afro');
  assert.equal(clusterOf('afro house'), 'afro');
  assert.equal(clusterOf('argentine trap'), 'regional');
  assert.equal(clusterOf('punjabi hip hop'), 'regional');
  assert.equal(clusterOf('uk r&b'), 'rnb-soul');
});

test('rejected genres land in other, never in a real scene', () => {
  for (const genre of ['country', 'heavy metal', 'post-punk', 'blues rock']) {
    assert.equal(clusterOf(genre), 'other', genre);
  }
});

// ── Release qualification ────────────────────────────────────────────────────

function album(partial: Partial<RawAlbum> & { name: string }): RawAlbum {
  return {
    id: partial.name,
    albumType: 'album',
    releaseDate: '2016-06-01',
    totalTracks: 12,
    markets: 100,
    ...partial,
  };
}

function qualify(albums: RawAlbum[]) {
  return selectYearReleases(albums, 2016, 'artist1', 'Test Artist');
}

test('keeps albums and multi-track EPs, drops standalone singles', () => {
  const { releases } = qualify([
    album({ name: 'Real Album' }),
    album({ name: 'An EP', albumType: 'single', totalTracks: 6 }),
    album({ name: 'A Single', albumType: 'single', totalTracks: 1 }),
  ]);
  assert.deepEqual(releases.map((r) => r.name).sort(), ['An EP', 'Real Album']);
});

test('drops reissues, compilations, live albums and remix packs', () => {
  const { releases, rejected } = qualify([
    album({ name: 'Classic (2016 Remaster)' }),
    album({ name: 'Greatest Hits' }),
    album({ name: 'Live at Wembley' }),
    album({ name: 'Hits (Remixes)' }),
    album({ name: 'Genuine Record' }),
  ]);
  assert.deepEqual(
    releases.map((r) => r.name),
    ['Genuine Record'],
  );
  assert.deepEqual(
    new Set(rejected.map((r) => r.reason)),
    new Set(['reissue', 'compilation', 'live', 'remix-pack']),
  );
});

test('catches an untitled reissue via an earlier release of the same record', () => {
  const { releases, rejected } = qualify([
    album({ name: 'Debut', releaseDate: '2001-03-01', id: 'old' }),
    album({ name: 'Debut', releaseDate: '2016-03-01', id: 'new' }),
  ]);
  assert.equal(releases.length, 0);
  assert.equal(rejected[0]?.reason, 'reissue-untitled');
});

test('a 25-track "single" is treated as a mislabeled compilation', () => {
  const { rejected } = qualify([
    album({ name: 'Bugatti', albumType: 'single', totalTracks: 25 }),
  ]);
  assert.equal(rejected[0]?.reason, 'mislabeled-compilation');
});

test('prefers the deluxe edition, inverting the weekly-fill rule', () => {
  // A week collection keeps only a deluxe release's bonus tracks because the
  // base album was collected on its own release week. A year collection has
  // no such history, so the superset is the complete record.
  const { releases, rejected } = qualify([
    album({ name: 'Still Brazy', totalTracks: 12, id: 'base' }),
    album({ name: 'Still Brazy (Deluxe)', totalTracks: 17, id: 'deluxe' }),
  ]);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, 'deluxe');
  assert.match(rejected[0]?.reason ?? '', /^superseded-by/);
});

test('ignores releases outside the target year at any date precision', () => {
  const { releases } = qualify([
    album({ name: 'In Year', releaseDate: '2016' }),
    album({ name: 'In Year Month', releaseDate: '2016-04' }),
    album({ name: 'Wrong Year', releaseDate: '2015-12-31' }),
  ]);
  assert.deepEqual(releases.map((r) => r.name).sort(), [
    'In Year',
    'In Year Month',
  ]);
});

// ── Acclaim ──────────────────────────────────────────────────────────────────

function release(id: string, cluster: string, name = id) {
  return {
    id,
    name,
    artistId: `a-${id}`,
    artistName: `Artist ${id}`,
    albumType: 'album',
    releaseDate: '2016-06-01',
    totalTracks: 10,
    markets: 100,
    cluster,
  } as Parameters<typeof scoreAcclaim>[0][number];
}

test('percentiles are computed within cluster, so scenes do not compete', () => {
  // Raw Spotify popularity would put Views (89) far above Konnichiwa (65).
  const scored = scoreAcclaim(
    [
      release('views', 'us-rap'),
      release('weak-rap', 'us-rap'),
      release('konnichiwa', 'grime'),
      release('weak-grime', 'grime'),
    ],
    new Map([
      ['views', 89],
      ['weak-rap', 30],
      ['konnichiwa', 65],
      ['weak-grime', 20],
    ]),
    new Map(),
    new Map(),
  );

  const byId = new Map(scored.map((r) => [r.id, r]));
  assert.equal(byId.get('views')?.acclaim, 1);
  assert.equal(byId.get('konnichiwa')?.acclaim, 1);
});

test('Last.fm below the sample floor is absent, not low', () => {
  const scored = scoreAcclaim(
    [release('covered', 'afro'), release('sparse', 'afro')],
    new Map([
      ['covered', 50],
      ['sparse', 80],
    ]),
    new Map(),
    new Map([
      ['covered', { listeners: MIN_LASTFM_LISTENERS + 1, playcount: 10_000 }],
      // 67 listeners is the real figure for a 2016 Afro record — a percentile
      // over numbers this small measures noise, not quality.
      ['sparse', { listeners: 67, playcount: 856 }],
    ]),
  );

  const byId = new Map(scored.map((r) => [r.id, r]));
  assert.equal(byId.get('sparse')?.criticFallback, true);
  assert.equal(byId.get('sparse')?.percentiles.critic, null);
  assert.equal(byId.get('sparse')?.signals.lastfmBelowFloor, true);
  // Scored on streaming alone at full weight — and it has the better streaming
  // figure, so it must outrank the covered release rather than be buried.
  assert.ok(
    (byId.get('sparse')?.acclaim ?? 0) > (byId.get('covered')?.acclaim ?? 1),
  );
});

test('the acclaim floor leaves small clusters intact', () => {
  const scored = scoreAcclaim(
    [release('a', 'jazz'), release('b', 'jazz')],
    new Map([
      ['a', 10],
      ['b', 90],
    ]),
    new Map(),
    new Map(),
  );
  const { kept, cut } = applyFloor(scored);
  assert.equal(
    kept.length,
    2,
    'a 2-release cluster has no meaningful quartile',
  );
  assert.equal(cut.length, 0);
});

// ── Failure accounting ───────────────────────────────────────────────────────

test('a small Spotify failure rate is degradation; the same rate on Deezer is not', () => {
  const log = new FailureLog(emptyCheckpoint(2016));
  log.attempt('album details', 1000);
  log.record('album details', 30); // 3%
  log.attempt('deezer acclaim', 1000);
  log.record('deezer acclaim', 300); // 30% — normal miss rate

  const degraded = degradedPhases(log);
  assert.deepEqual(
    degraded.map((d) => d.phase),
    ['album details'],
  );
});

test('a Deezer outage still registers as degradation', () => {
  const log = new FailureLog(emptyCheckpoint(2016));
  log.attempt('deezer acclaim', 1000);
  log.record('deezer acclaim', 900);
  assert.equal(degradedPhases(log).length, 1);
});

test('a clean run reports nothing degraded', () => {
  const log = new FailureLog(emptyCheckpoint(2016));
  log.attempt('album details', 500);
  assert.deepEqual(degradedPhases(log), []);
});

// ── Month bucketing ──────────────────────────────────────────────────────────

test('buckets releases by month, defaulting year-only dates to January', () => {
  assert.equal(monthOf('2016-03-04', 2016), '2016.03');
  assert.equal(monthOf('2016-11', 2016), '2016.11');
  assert.equal(monthOf('2016', 2016), '2016.01');
});

test('month names avoid the DD.MM.YY pattern the weekly system matches', () => {
  // A playlist called 01.01.16 would be read as a weekly playlist by fill-run
  // and non-listened-playlists, which both match exact DD.MM.YY names.
  const weeklyPattern = /^(\d{2})\.(\d{2})\.(\d{2})$/;
  for (let month = 1; month <= 12; month++) {
    const name = monthOf(`2016-${String(month).padStart(2, '0')}-01`, 2016);
    assert.ok(!weeklyPattern.test(name), `${name} collides with weekly names`);
  }
});
