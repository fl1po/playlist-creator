import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TrustedArtistsFile } from '../lib/types.js';
import {
  fixedPopularitySource,
  memoryCheckpoints,
} from '../services/week-collection/adapters.js';
import {
  type CollectionDecision,
  collectWeek,
  type ReleaseReads,
  type WeekCollectionInput,
  type WeekCollectionPorts,
} from '../services/week-collection/index.js';
import { fixtureReads } from './fixtures/release-catalog.js';

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

  // Regression: the gate once ignored config and used a hardcoded 10, which
  // popularity 40 always cleared. It must honour the configured minimum.
  const gated = await collectWeek(
    input({ roster: [['Delta', P1]], editorial: editorial(60) }),
    ports(makeReads(), { 'alb-mid': 40 }),
  );
  assert.deepEqual(gated.tracks, []);
  // Discovered, but it never landed: not a find.
  assert.deepEqual(kinds(gated.decisions), ['low-popularity']);

  const kept = await collectWeek(
    input({ roster: [['Delta', P1]], editorial: editorial(30) }),
    ports(makeReads(), { 'alb-mid': 40 }),
  );
  assert.deepEqual(kept.tracks, ['m1']);
  assert.deepEqual(kinds(kept.decisions), ['release-found']);
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
      pl1: ['alb-e'],
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
});

test('completing the search saves a completed checkpoint instead of clearing it', async () => {
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
      { id: 'art-b', name: 'Beta', albums: [] },
    ],
  });
  const checkpoints = memoryCheckpoints();

  await collectWeek(
    input({
      roster: [
        ['Alpha', P1],
        ['Beta', P2],
      ],
    }),
    { reads, popularity: fixedPopularitySource({ 'alb-x': 70 }), checkpoints },
  );

  assert.equal(checkpoints.current?.week, WEEK);
  assert.equal(checkpoints.current?.artistsSearched, 2);
  assert.deepEqual(Object.keys(checkpoints.current?.foundReleases ?? {}), [
    'alb-x',
  ]);
});

test('resuming a completed checkpoint searches no artists and finds the same releases', async () => {
  const catalog = {
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
  };
  const roster: WeekCollectionInput['roster'] = [
    ['Alpha', P1],
    ['Beta', P2],
  ];
  const scores = { 'alb-x': 80, 'alb-y': 70 };
  const checkpoints = memoryCheckpoints();
  const first = await collectWeek(input({ roster }), {
    reads: fixtureReads(catalog),
    popularity: fixedPopularitySource(scores),
    checkpoints,
  });

  const reads = fixtureReads(catalog);
  const resumed = await collectWeek(input({ roster }), {
    reads,
    popularity: fixedPopularitySource(scores),
    checkpoints,
  });

  assert.deepEqual(reads.searchCalls, []);
  assert.deepEqual(resumed.releases, first.releases);
  assert.deepEqual(resumed.tracks, ['t1', 's1']);
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
