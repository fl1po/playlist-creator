import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getValidDates, parseDate } from '../domain/tracks.js';
import type { FoundRelease } from '../lib/types.js';
import { fixedPopularitySource } from '../services/week-collection/adapters.js';
import {
  collect,
  createRun,
  gate,
  getArtistWindowReleases,
  type Run,
} from '../services/week-collection/engine.js';
import type {
  CollectionDecision,
  ReleaseReads,
} from '../services/week-collection/index.js';
import { type Catalog, fixtureReads } from './fixtures/release-catalog.js';

// Release qualification, tested at the engine's interface: the rules both
// week collection and promotion sync run their releases through.

// ── Helpers ──────────────────────────────────────────────────────────────────

const WEEK = '05.06.26'; // window: 2026-05-30 … 2026-06-05
const WINDOW = getValidDates(parseDate(WEEK));
const IN_WINDOW = '2026-06-05';
const OUT_OF_WINDOW = '2024-01-01';

function run(reads: ReleaseReads, scores: Record<string, number> = {}): Run {
  return createRun({ reads, popularity: fixedPopularitySource(scores) });
}

function kinds(decisions: CollectionDecision[]): string[] {
  return decisions.map((d) => d.kind);
}

/** Found releases for every catalog album with an id in `ids`. */
function found(catalog: Catalog, ids: string[]): Map<string, FoundRelease> {
  const releases = new Map<string, FoundRelease>();
  for (const artist of catalog.artists) {
    for (const album of artist.albums) {
      if (!ids.includes(album.id)) continue;
      releases.set(album.id, {
        id: album.id,
        name: album.name,
        type: album.type,
        release_date: album.release_date,
        artistName: artist.name,
        artistSpotifyId: artist.id,
        priority: 1,
        score: 100,
      });
    }
  }
  return releases;
}

// ── Discovery ────────────────────────────────────────────────────────────────

test('discovery keeps only in-window releases', async () => {
  const reads = fixtureReads({
    artists: [
      {
        id: 'art-a',
        name: 'Alpha',
        albums: [
          {
            id: 'alb-new',
            name: 'New',
            type: 'album',
            release_date: IN_WINDOW,
            tracks: [],
          },
          {
            id: 'alb-old',
            name: 'Old',
            type: 'album',
            release_date: OUT_OF_WINDOW,
            tracks: [],
          },
        ],
      },
    ],
  });

  const releases = await getArtistWindowReleases(run(reads), 'art-a', WINDOW);

  assert.deepEqual(
    releases.map((r) => r.id),
    ['alb-new'],
  );
});

test('discovery groups variants inside the window and picks the explicit one', async () => {
  const reads = fixtureReads({
    artists: [
      {
        id: 'art-v',
        name: 'Vera',
        albums: [
          {
            id: 'v-clean',
            name: 'Doppel',
            type: 'album',
            release_date: IN_WINDOW,
            markets: 5,
            explicit: false,
            tracks: [],
          },
          {
            id: 'v-explicit',
            name: 'Doppel',
            type: 'album',
            release_date: IN_WINDOW,
            markets: 3,
            explicit: true,
            tracks: [],
          },
          // Widest markets and explicit, but out of window: never grouped.
          {
            id: 'v-out',
            name: 'Doppel',
            type: 'album',
            release_date: OUT_OF_WINDOW,
            markets: 9,
            explicit: true,
            tracks: [],
          },
        ],
      },
    ],
  });
  const r = run(reads);

  const releases = await getArtistWindowReleases(r, 'art-v', WINDOW);

  assert.deepEqual(
    releases.map((x) => x.id),
    ['v-explicit'],
  );
  assert.deepEqual(r.decisions, [
    {
      kind: 'variant-picked',
      release: 'Doppel',
      variantCount: 2,
      explicit: true,
    },
  ]);
});

// ── Popularity gate ──────────────────────────────────────────────────────────

test('the gate drops releases below the floor with a decision; unknown popularity passes', async () => {
  const catalog: Catalog = {
    artists: [
      {
        id: 'art-g',
        name: 'Gamma',
        albums: ['alb-low', 'alb-floor', 'alb-unknown'].map((id) => ({
          id,
          name: id,
          type: 'album',
          release_date: IN_WINDOW,
          tracks: [],
        })),
      },
    ],
  };
  const r = run(fixtureReads(catalog), { 'alb-low': 59, 'alb-floor': 60 });

  const { kept, dropped, popularity } = await gate(
    r,
    found(catalog, ['alb-low', 'alb-floor', 'alb-unknown']),
    60,
  );

  assert.deepEqual([...kept.keys()], ['alb-floor', 'alb-unknown']);
  assert.deepEqual(
    dropped.map((d) => d.id),
    ['alb-low'],
  );
  assert.equal(popularity.get('alb-floor'), 60);
  assert.deepEqual(r.decisions, [
    {
      kind: 'low-popularity',
      artist: 'Gamma',
      release: 'alb-low',
      albumId: 'alb-low',
      popularity: 59,
    },
  ]);
});

// ── Variant strip ────────────────────────────────────────────────────────────

test('alternate versions are stripped when the original is kept', async () => {
  const catalog: Catalog = {
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
          {
            id: 'alb-sped',
            name: 'Loud (Sped Up)',
            type: 'single',
            release_date: IN_WINDOW,
            tracks: [{ id: 's1', name: 'Loud', key: 'echo::loud sped' }],
          },
        ],
      },
    ],
  };
  const r = run(fixtureReads(catalog));

  const { collected } = await collect(
    r,
    found(catalog, ['alb-z', 'alb-zi', 'alb-sped']),
    new Set(),
  );

  assert.deepEqual(
    collected.map((c) => c.trackIds),
    [['z1']],
  );
  assert.deepEqual(r.decisions, [
    {
      kind: 'variant-stripped',
      reason: 'instrumental',
      artist: 'Echo',
      release: 'Album Z (Instrumental)',
    },
    {
      kind: 'variant-stripped',
      reason: 'sped up',
      artist: 'Echo',
      release: 'Loud (Sped Up)',
    },
  ]);
});

// ── Track rules ──────────────────────────────────────────────────────────────

test('excluded tracks are skipped and counted', async () => {
  const catalog: Catalog = {
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
            ],
          },
        ],
      },
    ],
  };

  const { collected, skippedCount } = await collect(
    run(fixtureReads(catalog)),
    found(catalog, ['alb-x']),
    new Set(['t2']),
  );

  assert.deepEqual(
    collected.map((c) => c.trackIds),
    [['t1']],
  );
  assert.equal(skippedCount, 1);
});

test('deluxe release: only tracks absent from the base album qualify', async () => {
  const catalog: Catalog = {
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
  };
  const r = run(fixtureReads(catalog));

  const { collected, skippedCount } = await collect(
    r,
    found(catalog, ['alb-dlx']),
    new Set(),
  );

  assert.deepEqual(
    collected.map((c) => c.trackIds),
    [['d3']],
  );
  assert.equal(skippedCount, 2);
  assert.deepEqual(r.decisions, [
    {
      kind: 'deluxe-stripped',
      release: 'Best Album (Deluxe)',
      baseName: 'Best Album',
      originalTrackCount: 2,
      bonusTracks: 1,
    },
  ]);
});

test('title-track-only: single promotion contributes only the title track', async () => {
  const catalog: Catalog = {
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
  };
  const r = run(fixtureReads(catalog));

  const { collected, skippedCount } = await collect(
    r,
    found(catalog, ['alb-hit']),
    new Set(),
  );

  assert.deepEqual(
    collected.map((c) => c.trackIds),
    [['h1']],
  );
  assert.equal(skippedCount, 2);
  assert.deepEqual(r.decisions, [
    {
      kind: 'title-track-only',
      release: 'Hit Song',
      track: 'Hit Song',
      oldTracks: 2,
      otherTracks: 2,
    },
  ]);
});

test('a single duplicating an album track is skipped with a decision', async () => {
  const catalog: Catalog = {
    artists: [
      {
        id: 'art-h',
        name: 'Hotel',
        albums: [
          {
            id: 'sgl-h',
            name: 'Same',
            type: 'single',
            release_date: IN_WINDOW,
            tracks: [{ id: 'hs1', name: 'Same', key: 'hotel::same' }],
          },
          {
            id: 'alb-h',
            name: 'AlbumH',
            type: 'album',
            release_date: IN_WINDOW,
            tracks: [{ id: 'ha1', name: 'Same', key: 'hotel::same' }],
          },
        ],
      },
    ],
  };
  const r = run(fixtureReads(catalog));

  // The single comes first in the input; albums are collected first anyway.
  const { collected } = await collect(
    r,
    found(catalog, ['sgl-h', 'alb-h']),
    new Set(),
  );

  assert.deepEqual(
    collected.map((c) => c.release.id),
    ['alb-h'],
  );
  assert.deepEqual(r.decisions, [{ kind: 'single-skipped', release: 'Same' }]);
});

test('an all-instrumental release is stripped', async () => {
  const catalog: Catalog = {
    artists: [
      {
        id: 'art-i',
        name: 'India',
        albums: [
          {
            id: 'alb-i',
            name: 'Beats',
            type: 'album',
            release_date: IN_WINDOW,
            tracks: [
              { id: 'i1', name: 'One - Instrumental', key: 'india::one' },
              { id: 'i2', name: 'Two - Instrumental', key: 'india::two' },
            ],
          },
        ],
      },
    ],
  };
  const r = run(fixtureReads(catalog));

  const { collected } = await collect(r, found(catalog, ['alb-i']), new Set());

  assert.deepEqual(collected, []);
  assert.deepEqual(kinds(r.decisions), ['variant-stripped']);
});

test('a release whose reads throw fails collection unless contained', async () => {
  const catalog: Catalog = {
    artists: [
      {
        id: 'art-a',
        name: 'Alpha',
        albums: [
          {
            id: 'alb-ok',
            name: 'Fine',
            type: 'album',
            release_date: IN_WINDOW,
            tracks: [{ id: 'f1', name: 'Fine', key: 'alpha::fine' }],
          },
          {
            id: 'alb-bad',
            name: 'Broken',
            type: 'album',
            release_date: IN_WINDOW,
            tracks: [{ id: 'x1', name: 'Broken', key: 'alpha::broken' }],
          },
        ],
      },
    ],
  };
  const base = fixtureReads(catalog);
  const reads: ReleaseReads = {
    ...base,
    async albumTracks(albumId) {
      if (albumId === 'alb-bad') throw new Error('boom');
      return base.albumTracks(albumId);
    },
  };
  const releases = found(catalog, ['alb-ok', 'alb-bad']);

  await assert.rejects(collect(run(reads), releases, new Set()), /boom/);

  const { collected, contained } = await collect(
    run(reads),
    releases,
    new Set(),
    () => true,
  );
  assert.deepEqual(
    collected.map((c) => c.release.id),
    ['alb-ok'],
  );
  assert.deepEqual(
    contained.map(({ release, error }) => [
      release.id,
      (error as Error).message,
    ]),
    [['alb-bad', 'boom']],
  );
});
