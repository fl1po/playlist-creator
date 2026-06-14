import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AlbumTrack,
  PlaylistAlbumInfo,
  TrustedArtistsFile,
} from '../lib/types.js';
import {
  fixedPopularitySource,
  memoryCheckpoints,
} from '../services/week-collection/adapters.js';
import {
  type ArtistProfile,
  type CollectionDecision,
  type ReleaseReads,
  type WeekCollectionInput,
  type WeekCollectionPorts,
  collectWeek,
} from '../services/week-collection/index.js';

// ── Fixture catalog ──────────────────────────────────────────────────────────

interface FixtureAlbum {
  id: string;
  name: string;
  type: string;
  release_date: string;
  markets?: number;
  explicit?: boolean;
  tracks: AlbumTrack[];
}

interface FixtureArtist {
  id: string;
  name: string;
  albums: FixtureAlbum[];
}

interface Catalog {
  artists: FixtureArtist[];
  playlistAlbums?: Record<string, PlaylistAlbumInfo[]>;
  profiles?: Record<string, ArtistProfile>;
}

function fixtureReads(catalog: Catalog): ReleaseReads & {
  searchCalls: string[];
} {
  const findAlbum = (albumId: string) => {
    for (const artist of catalog.artists) {
      const album = artist.albums.find((a) => a.id === albumId);
      if (album) return { artist, album };
    }
    return null;
  };

  return {
    searchCalls: [],
    async searchArtist(name) {
      this.searchCalls.push(name);
      const artist = catalog.artists.find(
        (a) => a.name.toLowerCase() === name.toLowerCase(),
      );
      return artist ? { id: artist.id, name: artist.name } : null;
    },
    async artistAlbums(artistId) {
      const artist = catalog.artists.find((a) => a.id === artistId);
      return (artist?.albums ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        release_date: a.release_date,
        markets: a.markets ?? 0,
      }));
    },
    async albumDetails(albumId) {
      const hit = findAlbum(albumId);
      if (!hit) return null;
      return {
        id: hit.album.id,
        name: hit.album.name,
        type: hit.album.type,
        release_date: hit.album.release_date,
        explicit: hit.album.explicit ?? false,
        markets: hit.album.markets ?? 0,
        artists: [{ id: hit.artist.id, name: hit.artist.name }],
      };
    },
    async albumTracks(albumId) {
      return findAlbum(albumId)?.album.tracks ?? [];
    },
    async playlistAlbums(playlistId) {
      const infos = catalog.playlistAlbums?.[playlistId] ?? [];
      return new Map(infos.map((i) => [i.id, i]));
    },
    async userPlaylists() {
      return [];
    },
    async artistProfile(artistId) {
      return catalog.profiles?.[artistId] ?? null;
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const WEEK = '05.06.26'; // window: 2026-05-30 … 2026-06-05
const IN_WINDOW = '2026-06-05';

function trusted(
  artistCounts: TrustedArtistsFile['artistCounts'] = {},
): TrustedArtistsFile {
  return { artistCounts } as unknown as TrustedArtistsFile;
}

function input(
  overrides: Partial<WeekCollectionInput> = {},
): WeekCollectionInput {
  return {
    week: WEEK,
    roster: [],
    trustedArtists: trusted(),
    listeningHistory: new Set(),
    editorial: {
      playlists: [],
      externalSources: [],
      gate: { minPopularity: 60, minFollowers: 100_000 },
    },
    ...overrides,
  };
}

function ports(
  reads: ReleaseReads,
  scores: Record<string, number> = {},
): WeekCollectionPorts {
  return {
    reads,
    popularity: fixedPopularitySource(scores),
    checkpoints: memoryCheckpoints(),
  };
}

function kinds(decisions: CollectionDecision[]): string[] {
  return decisions.map((d) => d.kind);
}

const P1 = { priority: 1, score: 100 };
const P2 = { priority: 2, score: 40 };

// ── Tests ────────────────────────────────────────────────────────────────────

test('collects in-window releases, excludes history, ranks by popularity', async () => {
  const reads = fixtureReads({
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
            tracks: [
              { id: 't1', name: 'One', key: 'alpha::one' },
              { id: 't2', name: 'Two', key: 'alpha::two' },
              { id: 't3', name: 'Three', key: 'alpha::three' },
            ],
          },
          {
            id: 'alb-old',
            name: 'Old',
            type: 'album',
            release_date: '2024-01-01',
            tracks: [{ id: 'o1', name: 'Oldie', key: 'alpha::oldie' }],
          },
        ],
      },
      {
        id: 'art-b',
        name: 'Beta',
        albums: [
          {
            id: 'alb-y',
            name: 'Y',
            type: 'single',
            release_date: IN_WINDOW,
            tracks: [{ id: 's1', name: 'Solo', key: 'beta::solo' }],
          },
        ],
      },
    ],
  });

  const week = await collectWeek(
    input({
      roster: [
        ['Alpha', P1],
        ['Beta', P2],
      ],
      listeningHistory: new Set(['t2']),
    }),
    ports(reads, { 'alb-x': 70, 'alb-y': 80 }),
  );

  // Out-of-window album excluded; t2 excluded as listening history.
  assert.deepEqual(week.tracks, ['s1', 't1', 't3']); // Y ranks above X
  assert.equal(week.skippedCount, 1);
  // Releases keep collection order (albums first), not popularity order.
  assert.deepEqual(
    week.releases.map((r) => [r.id, r.tracksAdded]),
    [
      ['alb-x', 2],
      ['alb-y', 1],
    ],
  );
  assert.deepEqual(kinds(week.decisions), ['release-found', 'release-found']);
});

test('low-popularity releases are gated out with a decision', async () => {
  const reads = fixtureReads({
    artists: [
      {
        id: 'art-c',
        name: 'Gamma',
        albums: [
          {
            id: 'alb-w',
            name: 'W',
            type: 'album',
            release_date: IN_WINDOW,
            tracks: [{ id: 'w1', name: 'Weak', key: 'gamma::weak' }],
          },
        ],
      },
    ],
  });

  const week = await collectWeek(
    input({ roster: [['Gamma', P1]] }),
    ports(reads, { 'alb-w': 5 }),
  );

  assert.deepEqual(week.tracks, []);
  const lowPop = week.decisions.find((d) => d.kind === 'low-popularity');
  assert.deepEqual(lowPop, {
    kind: 'low-popularity',
    artist: 'Gamma',
    release: 'W',
    popularity: 5,
  });
});

test('release popularity gate uses the configured minPopularity threshold', async () => {
  const makeReads = () =>
    fixtureReads({
      artists: [
        {
          id: 'art-d',
          name: 'Delta',
          albums: [
            {
              id: 'alb-mid',
              name: 'Midpop',
              type: 'album',
              release_date: IN_WINDOW,
              tracks: [{ id: 'm1', name: 'Mid', key: 'delta::mid' }],
            },
          ],
        },
      ],
    });
  const editorial = (minPopularity: number) => ({
    playlists: [],
    externalSources: [],
    gate: { minPopularity, minFollowers: 100_000 },
  });

  // Popularity 40 sits in the old hardcoded-10 gap: gated at 60, kept at 30.
  const gated = await collectWeek(
    input({ roster: [['Delta', P1]], editorial: editorial(60) }),
    ports(makeReads(), { 'alb-mid': 40 }),
  );
  assert.deepEqual(gated.tracks, []);
  assert.ok(gated.decisions.some((d) => d.kind === 'low-popularity'));

  const kept = await collectWeek(
    input({ roster: [['Delta', P1]], editorial: editorial(30) }),
    ports(makeReads(), { 'alb-mid': 40 }),
  );
  assert.deepEqual(kept.tracks, ['m1']);
});

test('same-release duplicates: the explicit variant is picked', async () => {
  const reads = fixtureReads({
    artists: [
      {
        id: 'art-d',
        name: 'Delta',
        albums: [
          {
            id: 'v1',
            name: 'Doppel',
            type: 'album',
            release_date: IN_WINDOW,
            markets: 5,
            explicit: false,
            tracks: [{ id: 'v1t', name: 'Cut', key: 'delta::cut' }],
          },
          {
            id: 'v2',
            name: 'Doppel',
            type: 'album',
            release_date: IN_WINDOW,
            markets: 3,
            explicit: true,
            tracks: [{ id: 'v2t', name: 'Cut', key: 'delta::cut' }],
          },
        ],
      },
    ],
  });

  const week = await collectWeek(
    input({ roster: [['Delta', P1]] }),
    ports(reads, { v2: 70 }),
  );

  assert.deepEqual(week.tracks, ['v2t']);
  const pick = week.decisions.find((d) => d.kind === 'variant-picked');
  assert.deepEqual(pick, {
    kind: 'variant-picked',
    release: 'Doppel',
    variantCount: 2,
    explicit: true,
  });
});

test('alternate versions: instrumental stripped when the original exists', async () => {
  const reads = fixtureReads({
    artists: [
      {
        id: 'art-e',
        name: 'Echo',
        albums: [
          {
            id: 'alb-z',
            name: 'Album Z',
            type: 'album',
            release_date: IN_WINDOW,
            tracks: [{ id: 'z1', name: 'Zed', key: 'echo::zed' }],
          },
          {
            id: 'alb-zi',
            name: 'Album Z (Instrumental)',
            type: 'album',
            release_date: IN_WINDOW,
            tracks: [{ id: 'zi1', name: 'Zed', key: 'echo::zed inst' }],
          },
        ],
      },
    ],
  });

  const week = await collectWeek(
    input({ roster: [['Echo', P1]] }),
    ports(reads, { 'alb-z': 70, 'alb-zi': 70 }),
  );

  assert.deepEqual(week.tracks, ['z1']);
  const strip = week.decisions.find((d) => d.kind === 'variant-stripped');
  assert.deepEqual(strip, {
    kind: 'variant-stripped',
    reason: 'instrumental',
    artist: 'Echo',
    release: 'Album Z (Instrumental)',
  });
});

test('deluxe release: only tracks absent from the base album qualify', async () => {
  const reads = fixtureReads({
    artists: [
      {
        id: 'art-f',
        name: 'Foxtrot',
        albums: [
          {
            id: 'alb-dlx',
            name: 'Best Album (Deluxe)',
            type: 'album',
            release_date: IN_WINDOW,
            tracks: [
              { id: 'd1', name: 'A', key: 'foxtrot::a' },
              { id: 'd2', name: 'B', key: 'foxtrot::b' },
              { id: 'd3', name: 'Bonus', key: 'foxtrot::bonus' },
            ],
          },
          {
            id: 'alb-base',
            name: 'Best Album',
            type: 'album',
            release_date: '2025-01-10',
            tracks: [
              { id: 'b1', name: 'A', key: 'foxtrot::a' },
              { id: 'b2', name: 'B', key: 'foxtrot::b' },
            ],
          },
        ],
      },
    ],
  });

  const week = await collectWeek(
    input({ roster: [['Foxtrot', P1]] }),
    ports(reads, { 'alb-dlx': 70 }),
  );

  assert.deepEqual(week.tracks, ['d3']);
  assert.equal(week.skippedCount, 2);
  const deluxe = week.decisions.filter((d) => d.kind === 'deluxe-stripped');
  assert.equal(deluxe.length, 2);
  assert.deepEqual(deluxe[1], {
    kind: 'deluxe-stripped',
    release: 'Best Album (Deluxe)',
    baseName: 'Best Album',
    originalTrackCount: 2,
    bonusTracks: 1,
  });
});

test('title-track-only: single promotion contributes only the title track', async () => {
  const reads = fixtureReads({
    artists: [
      {
        id: 'art-g',
        name: 'Golf',
        albums: [
          {
            id: 'alb-hit',
            name: 'Hit Song',
            type: 'album',
            release_date: IN_WINDOW,
            tracks: [
              { id: 'h1', name: 'Hit Song', key: 'golf::hit song' },
              { id: 'h2', name: 'Filler A', key: 'golf::old one' },
              { id: 'h3', name: 'Filler B', key: 'golf::old two' },
            ],
          },
          {
            id: 'alb-prev',
            name: 'Previous',
            type: 'album',
            release_date: '2024-05-01',
            tracks: [
              { id: 'p1', name: 'Old One', key: 'golf::old one' },
              { id: 'p2', name: 'Old Two', key: 'golf::old two' },
            ],
          },
        ],
      },
    ],
  });

  const week = await collectWeek(
    input({ roster: [['Golf', P1]] }),
    ports(reads, { 'alb-hit': 70 }),
  );

  assert.deepEqual(week.tracks, ['h1']);
  assert.equal(week.skippedCount, 2);
  const tto = week.decisions.find((d) => d.kind === 'title-track-only');
  assert.deepEqual(tto, {
    kind: 'title-track-only',
    release: 'Hit Song',
    track: 'Hit Song',
    oldTracks: 2,
    otherTracks: 2,
  });
});

test('single duplicating an album track is skipped with a decision', async () => {
  const reads = fixtureReads({
    artists: [
      {
        id: 'art-h',
        name: 'Hotel',
        albums: [
          {
            id: 'alb-h',
            name: 'AlbumH',
            type: 'album',
            release_date: IN_WINDOW,
            tracks: [{ id: 'ha1', name: 'Same', key: 'hotel::same' }],
          },
          {
            id: 'sgl-h',
            name: 'Same',
            type: 'single',
            release_date: IN_WINDOW,
            tracks: [{ id: 'hs1', name: 'Same', key: 'hotel::same' }],
          },
        ],
      },
    ],
  });

  const week = await collectWeek(
    input({ roster: [['Hotel', P1]] }),
    ports(reads, { 'alb-h': 70, 'sgl-h': 70 }),
  );

  assert.deepEqual(week.tracks, ['ha1']);
  assert.ok(
    week.decisions.some(
      (d) => d.kind === 'single-skipped' && d.release === 'Same',
    ),
  );
});

test('editorial: unknown artist admitted through the popularity/genre gate', async () => {
  const reads = fixtureReads({
    artists: [
      {
        id: 'art-new',
        name: 'Newcomer',
        albums: [
          {
            id: 'alb-e',
            name: 'Fresh Drop',
            type: 'album',
            release_date: '2026-06-04',
            tracks: [{ id: 'e1', name: 'Fresh', key: 'newcomer::fresh' }],
          },
        ],
      },
    ],
    playlistAlbums: {
      pl1: [{ id: 'alb-e', name: 'Fresh Drop', artistName: 'Newcomer' }],
    },
    profiles: {
      'art-new': { popularity: 70, followers: 1000, genres: ['pop'] },
    },
  });

  const week = await collectWeek(
    input({
      editorial: {
        playlists: [{ id: 'pl1', name: 'Editors Picks' }],
        externalSources: [],
        gate: { minPopularity: 60, minFollowers: 100_000 },
      },
    }),
    ports(reads, { 'alb-e': 70 }),
  );

  assert.deepEqual(week.tracks, ['e1']);
  assert.equal(week.releases[0].priority, 'editorial');
  const found = week.decisions.find((d) => d.kind === 'release-found');
  assert.deepEqual(found, {
    kind: 'release-found',
    artist: 'Newcomer',
    release: 'Fresh Drop',
    type: 'album',
    source: 'Editors Picks',
  });
});

test('resumes from a checkpoint: already-searched artists are not re-searched', async () => {
  const reads = fixtureReads({
    artists: [
      { id: 'art-a', name: 'Alpha', albums: [] },
      {
        id: 'art-b',
        name: 'Beta',
        albums: [
          {
            id: 'alb-y',
            name: 'Y',
            type: 'single',
            release_date: IN_WINDOW,
            tracks: [{ id: 's1', name: 'Solo', key: 'beta::solo' }],
          },
        ],
      },
    ],
  });
  const checkpoints = memoryCheckpoints();
  checkpoints.current = { week: WEEK, artistsSearched: 1, foundReleases: {} };

  const week = await collectWeek(
    input({
      roster: [
        ['Alpha', P1],
        ['Beta', P2],
      ],
    }),
    {
      reads,
      popularity: fixedPopularitySource({ 'alb-y': 70 }),
      checkpoints,
    },
  );

  assert.deepEqual(reads.searchCalls, ['Beta']);
  assert.deepEqual(week.tracks, ['s1']);
  assert.equal(checkpoints.current, null); // cleared on completion
});

test('a throw mid-search checkpoints week progress before propagating', async () => {
  const reads = fixtureReads({
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
  });
  const failing: ReleaseReads = {
    ...reads,
    async searchArtist(name) {
      if (name === 'Boom') throw new Error('boom');
      return reads.searchArtist(name);
    },
  };
  const checkpoints = memoryCheckpoints();

  await assert.rejects(
    collectWeek(
      input({
        roster: [
          ['Alpha', P1],
          ['Boom', P2],
        ],
      }),
      { reads: failing, popularity: fixedPopularitySource({}), checkpoints },
    ),
    /boom/,
  );

  assert.equal(checkpoints.current?.week, WEEK);
  assert.equal(checkpoints.current?.artistsSearched, 1);
  assert.ok(checkpoints.current?.foundReleases['alb-x']);
});
