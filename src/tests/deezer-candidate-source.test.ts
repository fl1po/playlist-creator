import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type {
  DeezerAlbumDetail,
  DeezerArtist,
  DeezerArtistAlbum,
  DeezerTopTrack,
} from '../lib/deezer-client.js';
import { type DurableCache, createDurableCache } from '../lib/durable-cache.js';
import { TaskAborted } from '../lib/spotify/errors.js';
import {
  type DeezerReads,
  deezerCandidateSource,
} from '../services/ai-finds/deezer-candidate-source.js';
import type {
  CandidateReject,
  CandidateRequest,
} from '../services/week-collection/index.js';

// The Deezer CandidateSource over an in-memory Deezer catalog. Each artist
// call is counted, so tests can check what was fetched and what was cached.

// ── Fixture Deezer ──────────────────────────────────────────────────────────

interface FixtureArtist {
  id: number;
  name: string;
  fans: number;
  albums: Array<DeezerArtistAlbum & Partial<DeezerAlbumDetail>>;
  top: DeezerTopTrack[];
}

type Failing = 'searchArtist' | 'artistAlbums' | 'topTracks' | 'getAlbum';

function fixtureDeezer(artists: FixtureArtist[]) {
  const calls: string[] = [];
  const failing = new Map<string, Failing>();
  const album = (id: number) =>
    artists.flatMap((a) => a.albums).find((al) => al.id === id);
  const fails = (what: Failing, key: string) => failing.get(key) === what;
  const deezer: DeezerReads & {
    calls: string[];
    fail(what: Failing, artist: string): void;
  } = {
    calls,
    fail(what, artist) {
      failing.set(artist, what);
    },
    async searchArtist(name) {
      calls.push(`searchArtist ${name}`);
      if (fails('searchArtist', name)) return null;
      const a = artists.find((x) => x.name === name);
      if (!a) return 'not-found';
      return { id: a.id, name: a.name, nb_fan: a.fans } as DeezerArtist;
    },
    async artistAlbums(id) {
      calls.push(`artistAlbums ${id}`);
      const a = artists.find((x) => x.id === id);
      if (a && fails('artistAlbums', a.name)) return null;
      return (
        a?.albums.map(({ id, title, record_type, release_date }) => ({
          id,
          title,
          record_type,
          release_date,
        })) ?? []
      );
    },
    async getAlbum(id) {
      calls.push(`getAlbum ${id}`);
      const owner = artists.find((x) => x.albums.some((al) => al.id === id));
      if (owner && fails('getAlbum', owner.name)) {
        throw new TypeError('fetch failed');
      }
      const al = album(id);
      return al
        ? {
            fans: 0,
            explicit_lyrics: false,
            tracks: { data: [] },
            ...al,
          }
        : null;
    },
    async topTracks(id) {
      calls.push(`topTracks ${id}`);
      const a = artists.find((x) => x.id === id);
      if (a && fails('topTracks', a.name)) return null;
      return a?.top ?? [];
    },
    async searchAlbum(query) {
      calls.push(`searchAlbum ${query}`);
      return artists.flatMap((a) =>
        a.albums
          .filter((al) => query === `${a.name} ${al.title}`)
          .map((al) => ({
            id: al.id,
            title: al.title,
            record_type: al.record_type,
            artist: { id: a.id, name: a.name },
          })),
      );
    },
  };
  return deezer;
}

const tracks = (...ranks: number[]) => ({
  data: ranks.map((rank, i) => ({
    id: i,
    title: `T${i}`,
    rank,
    duration: 180,
    explicit_lyrics: false,
  })),
});

/** Top tracks on other albums, so none belong to the release judged. */
const usual = (...ranks: number[]): DeezerTopTrack[] =>
  ranks.map((rank) => ({ album: 999, rank }));

const WINDOW = ['2026-06-03', '2026-06-04', '2026-06-05'];

const nova: FixtureArtist = {
  id: 1,
  name: 'Nova',
  fans: 1200,
  albums: [
    {
      id: 10,
      title: 'Night Bus',
      record_type: 'single',
      release_date: '2026-06-05',
      upc: '0602445000010',
      nb_tracks: 2,
      genres: { data: [{ name: 'Rap/Hip Hop' }] },
      tracks: tracks(300_000, 50_000),
    },
    {
      id: 11,
      title: 'Old Tape',
      record_type: 'album',
      release_date: '2025-01-10',
      nb_tracks: 12,
      tracks: tracks(900_000),
    },
  ],
  top: usual(200_000, 400_000, 600_000),
};

const quill: FixtureArtist = {
  id: 2,
  name: 'Quill',
  fans: 80,
  albums: [
    {
      id: 20,
      title: 'Paper',
      record_type: 'ep',
      release_date: '2026-06-04',
      nb_tracks: 4,
      tracks: tracks(100_000),
    },
  ],
  top: usual(50_000, 80_000),
};

function request(over: Partial<CandidateRequest> = {}): CandidateRequest {
  return {
    seeds: [],
    rosterArtists: [
      { name: 'Nova', priority: 3, spotifyId: 'sp-nova' },
      { name: 'Quill', priority: null, spotifyId: null },
    ],
    scouting: [],
    rejects: [],
    window: WINDOW,
    ...over,
  };
}

function tempCache(): DurableCache {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidates-test-'));
  return createDurableCache({ userId: 'user-1', dataDir, redis: null });
}

const DAY = 24 * 60 * 60 * 1000;

// ── Roster artists ──────────────────────────────────────────────────────────

test('returns in-window roster releases in Deezer shape', async () => {
  const deezer = fixtureDeezer([nova, quill]);
  const source = deezerCandidateSource({ deezer, cache: tempCache() });

  const candidates = await source.candidates(request());

  assert.deepEqual(
    candidates.find((c) => c.title === 'Night Bus'),
    {
      id: 'dz-10',
      title: 'Night Bus',
      artist: 'Nova',
      type: 'single',
      trackCount: 2,
      releaseDate: '2026-06-05',
      genres: ['Rap/Hip Hop'],
      artistFans: 1200,
      upc: '0602445000010',
      relativePopularity: 0.75,
      provenance: [{ kind: 'roster', priority: 3 }],
    },
  );
  const paper = candidates.find((c) => c.title === 'Paper');
  assert.equal(paper?.upc, null);
  assert.deepEqual(paper?.provenance, [{ kind: 'roster', priority: null }]);
});

test('never returns out-of-window releases', async () => {
  const deezer = fixtureDeezer([nova]);
  const source = deezerCandidateSource({ deezer, cache: tempCache() });

  const candidates = await source.candidates(request());

  assert.deepEqual(
    candidates.map((c) => c.title),
    ['Night Bus'],
  );
  assert.ok(!deezer.calls.includes('getAlbum 11'));
});

test('a roster artist Deezer lacks yields nothing', async () => {
  const deezer = fixtureDeezer([nova]);
  const source = deezerCandidateSource({ deezer, cache: tempCache() });

  const candidates = await source.candidates(
    request({
      rosterArtists: [{ name: 'Ghost', priority: 4, spotifyId: null }],
    }),
  );

  assert.deepEqual(candidates, []);
});

// ── Relative popularity ─────────────────────────────────────────────────────

test('relative popularity is best rank over the median top-10 rank', async () => {
  // Best track 300k against a median of 400k across the usual tracks.
  const deezer = fixtureDeezer([nova]);
  const [c] = await deezerCandidateSource({
    deezer,
    cache: tempCache(),
  }).candidates(request());
  assert.equal(c?.relativePopularity, 0.75);
});

test("the release's own tracks don't count as the artist's usual", async () => {
  const deezer = fixtureDeezer([
    { ...nova, top: [{ album: 10, rank: 300_000 }, ...usual(600_000)] },
  ]);
  const [c] = await deezerCandidateSource({
    deezer,
    cache: tempCache(),
  }).candidates(request());
  assert.equal(c?.relativePopularity, 0.5);
});

test("Deezer's 100k placeholder rank leaves relative popularity missing", async () => {
  const deezer = fixtureDeezer([quill]);
  const [c] = await deezerCandidateSource({
    deezer,
    cache: tempCache(),
  }).candidates(request());
  assert.equal(c?.title, 'Paper');
  assert.equal(c?.relativePopularity, null);
});

test("placeholder ranks don't count as the artist's usual", async () => {
  const deezer = fixtureDeezer([
    { ...nova, top: usual(100_000, 100_000, 600_000) },
  ]);
  const [c] = await deezerCandidateSource({
    deezer,
    cache: tempCache(),
  }).candidates(request());
  assert.equal(c?.relativePopularity, 0.5);
});

test('no top tracks leaves relative popularity missing', async () => {
  const deezer = fixtureDeezer([{ ...nova, top: [] }]);
  const [c] = await deezerCandidateSource({
    deezer,
    cache: tempCache(),
  }).candidates(request());
  assert.equal(c?.relativePopularity, null);
});

// ── Caching ─────────────────────────────────────────────────────────────────

test('top-tracks lookups are cached across fills', async () => {
  const cache = tempCache();
  await deezerCandidateSource({
    deezer: fixtureDeezer([nova]),
    cache,
  }).candidates(request());

  const deezer = fixtureDeezer([nova]);
  const [c] = await deezerCandidateSource({ deezer, cache }).candidates(
    request(),
  );

  assert.equal(c?.relativePopularity, 0.75);
  assert.ok(!deezer.calls.some((call) => call.startsWith('topTracks')));
  assert.ok(!deezer.calls.some((call) => call.startsWith('searchArtist')));
});

test('top tracks are reused across weeks of one fill', async () => {
  const deezer = fixtureDeezer([nova]);
  const source = deezerCandidateSource({ deezer, cache: tempCache() });
  await source.candidates(request());
  await source.candidates(request());
  assert.equal(
    deezer.calls.filter((call) => call === 'topTracks 1').length,
    1,
  );
});

test('stale top tracks are fetched again', async () => {
  const cache = tempCache();
  let now = Date.parse('2026-06-06');
  await deezerCandidateSource({
    deezer: fixtureDeezer([nova]),
    cache,
    now: () => now,
  }).candidates(request());

  now += 60 * DAY;
  const deezer = fixtureDeezer([nova]);
  await deezerCandidateSource({ deezer, cache, now: () => now }).candidates(
    request(),
  );

  assert.ok(deezer.calls.includes('topTracks 1'));
});

test('a failed top-tracks lookup is not cached', async () => {
  const cache = tempCache();
  const failing = fixtureDeezer([nova]);
  failing.fail('topTracks', 'Nova');
  const [first] = await deezerCandidateSource({
    deezer: failing,
    cache,
  }).candidates(request());
  assert.equal(first?.relativePopularity, null);

  const deezer = fixtureDeezer([nova]);
  const [second] = await deezerCandidateSource({ deezer, cache }).candidates(
    request(),
  );
  assert.equal(second?.relativePopularity, 0.75);
});

// ── Rejects ─────────────────────────────────────────────────────────────────

const reject = (over: Partial<CandidateReject> = {}): CandidateReject => ({
  albumId: 'sp-10',
  artist: 'Nova',
  title: 'Night Bus',
  type: 'single',
  releaseDate: '2026-06-05',
  provenance: {
    kind: 'editorial-reject',
    reason: 'popularity 6',
    playlists: ['Fresh Finds'],
  },
  ...over,
});

test('rejects come back enriched with Deezer data and their gate provenance', async () => {
  const deezer = fixtureDeezer([nova]);
  const source = deezerCandidateSource({ deezer, cache: tempCache() });

  const candidates = await source.candidates(
    request({ rosterArtists: [], rejects: [reject()] }),
  );

  assert.deepEqual(candidates, [
    {
      id: 'reject-sp-10',
      title: 'Night Bus',
      artist: 'Nova',
      type: 'single',
      trackCount: 2,
      releaseDate: '2026-06-05',
      genres: ['Rap/Hip Hop'],
      artistFans: 1200,
      upc: '0602445000010',
      relativePopularity: 0.75,
      provenance: [reject().provenance],
      spotifyAlbumId: 'sp-10',
    },
  ]);
});

test('a reject Deezer lacks still comes back, unenriched', async () => {
  const deezer = fixtureDeezer([nova]);
  const lowPop: CandidateReject = reject({
    albumId: 'sp-77',
    artist: 'Stranger',
    title: 'Elsewhere',
    provenance: { kind: 'low-popularity', popularity: 3, playlists: [] },
  });

  const candidates = await deezerCandidateSource({
    deezer,
    cache: tempCache(),
  }).candidates(request({ rosterArtists: [], rejects: [lowPop] }));

  assert.deepEqual(candidates, [
    {
      id: 'reject-sp-77',
      title: 'Elsewhere',
      artist: 'Stranger',
      type: 'single',
      trackCount: 1,
      releaseDate: '2026-06-05',
      genres: [],
      artistFans: null,
      upc: null,
      relativePopularity: null,
      provenance: [lowPop.provenance],
      spotifyAlbumId: 'sp-77',
    },
  ]);
});

// ── Failures and abort ──────────────────────────────────────────────────────

for (const what of ['searchArtist', 'artistAlbums', 'getAlbum'] as const) {
  test(`a failed ${what} skips that artist only`, async () => {
    const deezer = fixtureDeezer([nova, quill]);
    deezer.fail(what, 'Nova');
    const candidates = await deezerCandidateSource({
      deezer,
      cache: tempCache(),
    }).candidates(request());
    assert.deepEqual(
      candidates.map((c) => c.title),
      ['Paper'],
    );
  });
}

test('a failed artist lookup is not cached as not-found', async () => {
  const cache = tempCache();
  const failing = fixtureDeezer([nova]);
  failing.fail('searchArtist', 'Nova');
  await deezerCandidateSource({ deezer: failing, cache }).candidates(
    request(),
  );

  const candidates = await deezerCandidateSource({
    deezer: fixtureDeezer([nova]),
    cache,
  }).candidates(request());
  assert.deepEqual(
    candidates.map((c) => c.title),
    ['Night Bus'],
  );
});

test('a failed reject lookup still returns the reject', async () => {
  const deezer = fixtureDeezer([nova]);
  deezer.fail('getAlbum', 'Nova');
  const candidates = await deezerCandidateSource({
    deezer,
    cache: tempCache(),
  }).candidates(request({ rosterArtists: [], rejects: [reject()] }));
  assert.equal(candidates[0]?.id, 'reject-sp-10');
  assert.equal(candidates[0]?.upc, null);
});

test('stopping the fill aborts the call and keeps the cache so far', async () => {
  const cache = tempCache();
  let checks = 0;
  const source = deezerCandidateSource({
    deezer: fixtureDeezer([nova, quill]),
    cache,
    checkAbort: () => {
      if (++checks > 1) throw new TaskAborted();
    },
  });

  await assert.rejects(source.candidates(request()), TaskAborted);

  const deezer = fixtureDeezer([nova, quill]);
  await deezerCandidateSource({ deezer, cache }).candidates(request());
  assert.ok(!deezer.calls.includes('searchArtist Nova'));
  assert.ok(deezer.calls.includes('searchArtist Quill'));
});

test('an abort raised inside a Deezer call escapes', async () => {
  const deezer = fixtureDeezer([nova, quill]);
  deezer.artistAlbums = async () => {
    throw new TaskAborted();
  };
  await assert.rejects(
    deezerCandidateSource({ deezer, cache: tempCache() }).candidates(
      request(),
    ),
    TaskAborted,
  );
});
