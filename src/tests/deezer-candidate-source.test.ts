import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RELATED_ARTIST_GRAPH } from '../lib/cache-files.js';
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
  CandidateProgress,
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
  /** Ids of the artist's related artists. */
  related?: number[];
}

type Failing =
  | 'searchArtist'
  | 'artistAlbums'
  | 'topTracks'
  | 'getAlbum'
  | 'relatedArtists';

function fixtureDeezer(artists: FixtureArtist[]) {
  const calls: string[] = [];
  const failing = new Map<string, Failing>();
  const album = (id: number) =>
    artists.flatMap((a) => a.albums).find((al) => al.id === id);
  const fails = (what: Failing, key: string) => failing.get(key) === what;
  const deezer: DeezerReads & {
    calls: string[];
    fail(what: Failing, artist: string): void;
    heal(artist: string): void;
  } = {
    calls,
    fail(what, artist) {
      failing.set(artist, what);
    },
    heal(artist) {
      failing.delete(artist);
    },
    async relatedArtists(id) {
      calls.push(`relatedArtists ${id}`);
      const a = artists.find((x) => x.id === id);
      if (a && fails('relatedArtists', a.name)) return null;
      return (a?.related ?? []).flatMap((rid) => {
        const r = artists.find((x) => x.id === rid);
        return r ? [{ id: r.id, name: r.name, nb_fan: r.fans }] : [];
      });
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
  assert.equal(deezer.calls.filter((call) => call === 'topTracks 1').length, 1);
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

// ── Scouting playlists ──────────────────────────────────────────────────────

const scouted = (
  playlist: string,
  over: Partial<CandidateRequest['scouting'][number]['album']> = {},
): CandidateRequest['scouting'][number] => ({
  playlist,
  album: {
    id: 'sp-10',
    name: 'Night Bus',
    artistName: 'Nova',
    artistIds: ['art-nova'],
    releaseDate: '2026-06-05',
    albumType: 'single',
    totalTracks: 2,
    ...over,
  },
});

test('a scouting release is looked up on Deezer and keeps its Spotify album id', async () => {
  const deezer = fixtureDeezer([nova]);
  const source = deezerCandidateSource({ deezer, cache: tempCache() });

  const candidates = await source.candidates(
    request({
      rosterArtists: [],
      scouting: [scouted('Fresh Finds'), scouted('Lorem')],
    }),
  );

  assert.deepEqual(candidates, [
    {
      id: 'scout-sp-10',
      title: 'Night Bus',
      artist: 'Nova',
      type: 'single',
      trackCount: 2,
      releaseDate: '2026-06-05',
      genres: ['Rap/Hip Hop'],
      artistFans: 1200,
      upc: '0602445000010',
      relativePopularity: 0.75,
      provenance: [
        { kind: 'scouting', playlist: 'Fresh Finds' },
        { kind: 'scouting', playlist: 'Lorem' },
      ],
      spotifyAlbumId: 'sp-10',
    },
  ]);
  assert.equal(
    deezer.calls.filter((c) => c.startsWith('searchAlbum')).length,
    1,
  );
});

test('a scouting release Deezer lacks stays Spotify-only', async () => {
  const deezer = fixtureDeezer([nova]);
  const candidates = await deezerCandidateSource({
    deezer,
    cache: tempCache(),
  }).candidates(
    request({
      rosterArtists: [],
      scouting: [
        scouted('Lorem', {
          id: 'sp-77',
          name: 'Elsewhere',
          artistName: 'Stranger',
          albumType: 'album',
          totalTracks: 9,
          releaseDate: '2026-06',
        }),
      ],
    }),
  );

  assert.deepEqual(candidates, [
    {
      id: 'scout-sp-77',
      title: 'Elsewhere',
      artist: 'Stranger',
      type: 'album',
      trackCount: 9,
      releaseDate: '2026-06',
      genres: [],
      artistFans: null,
      upc: null,
      relativePopularity: null,
      provenance: [{ kind: 'scouting', playlist: 'Lorem' }],
      spotifyAlbumId: 'sp-77',
    },
  ]);
});

test('a failed scouting lookup still returns the Spotify-only release', async () => {
  const deezer = fixtureDeezer([nova]);
  deezer.fail('getAlbum', 'Nova');
  const candidates = await deezerCandidateSource({
    deezer,
    cache: tempCache(),
  }).candidates(request({ rosterArtists: [], scouting: [scouted('Lorem')] }));
  assert.equal(candidates[0]?.id, 'scout-sp-10');
  assert.equal(candidates[0]?.upc, null);
  assert.deepEqual(candidates[0]?.genres, []);
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
  await deezerCandidateSource({ deezer: failing, cache }).candidates(request());

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
    deezerCandidateSource({ deezer, cache: tempCache() }).candidates(request()),
    TaskAborted,
  );
});

// ── Related-artist graph ────────────────────────────────────────────────────

// Ada names Nova, Quill and Lone; Bex names Nova and Quill; Cy names Nova.
// With all three as seeds, Nova and Quill are co-cited and Lone isn't.

const lone: FixtureArtist = {
  id: 3,
  name: 'Lone',
  fans: 40,
  albums: [
    {
      id: 30,
      title: 'Solo',
      record_type: 'single',
      release_date: '2026-06-03',
      tracks: tracks(200_000),
    },
  ],
  top: usual(400_000),
};

const seedArtist = (
  id: number,
  name: string,
  related: number[],
): FixtureArtist => ({ id, name, fans: 500_000, albums: [], top: [], related });

const ada = seedArtist(100, 'Ada', [1, 2, 3]);
const bex = seedArtist(101, 'Bex', [1, 2]);
const cy = seedArtist(102, 'Cy', [1]);
const graphArtists = () => [nova, quill, lone, ada, bex, cy];

const seeds = (...names: string[]) =>
  names.map((name) => ({ name, spotifyId: `sp-${name}` }));

/** A request whose only source is the graph of these seeds. */
const relatedTo = (...names: string[]) =>
  request({ seeds: seeds(...names), rosterArtists: [] });

const relatedCalls = (calls: string[]) =>
  calls.filter((c) => c.startsWith('relatedArtists'));

function recordingProgress() {
  const events: CandidateProgress[] = [];
  return { events, onProgress: (e: CandidateProgress) => events.push(e) };
}

test("co-cited related artists' in-window releases join the pool with the seeds that named them", async () => {
  const deezer = fixtureDeezer(graphArtists());
  const candidates = await deezerCandidateSource({
    deezer,
    cache: tempCache(),
  }).candidates(relatedTo('Ada', 'Bex', 'Cy'));

  const night = candidates.find((c) => c.title === 'Night Bus');
  assert.deepEqual(night, {
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
    provenance: [{ kind: 'related', to: ['Ada', 'Bex', 'Cy'] }],
  });
  assert.deepEqual(candidates.find((c) => c.title === 'Paper')?.provenance, [
    { kind: 'related', to: ['Ada', 'Bex'] },
  ]);
  // Lone is named by Ada alone.
  assert.ok(!candidates.some((c) => c.artist === 'Lone'));
  assert.ok(!deezer.calls.includes('artistAlbums 3'));
});

test('a related artist on the roster or among the seeds comes only through the roster', async () => {
  // Dee and Eve both name Ada, a seed herself, and Nova, on the roster.
  const deezer = fixtureDeezer([
    ...graphArtists(),
    seedArtist(103, 'Dee', [100, 1]),
    seedArtist(104, 'Eve', [100, 1]),
  ]);
  const candidates = await deezerCandidateSource({
    deezer,
    cache: tempCache(),
  }).candidates(
    request({
      seeds: seeds('Ada', 'Dee', 'Eve'),
      rosterArtists: [{ name: 'Nova', priority: 3, spotifyId: 'sp-nova' }],
    }),
  );

  assert.deepEqual(
    candidates.find((c) => c.title === 'Night Bus')?.provenance,
    [{ kind: 'roster', priority: 3 }],
  );
  assert.ok(!deezer.calls.includes('artistAlbums 100'));
});

test('the top-up counts seeds done against seeds to fetch', async () => {
  const progress = recordingProgress();
  await deezerCandidateSource({
    deezer: fixtureDeezer(graphArtists()),
    cache: tempCache(),
  }).candidates(relatedTo('Ada', 'Bex', 'Cy'), progress.onProgress);

  assert.deepEqual(progress.events, [
    { phase: 'related-artists', done: 0, total: 3 },
    { phase: 'related-artists', done: 1, total: 3 },
    { phase: 'related-artists', done: 2, total: 3 },
    { phase: 'related-artists', done: 3, total: 3 },
  ]);
});

test('fresh graph entries are not fetched again by a later fill', async () => {
  const cache = tempCache();
  await deezerCandidateSource({
    deezer: fixtureDeezer(graphArtists()),
    cache,
  }).candidates(relatedTo('Ada', 'Bex'));

  const deezer = fixtureDeezer(graphArtists());
  const progress = recordingProgress();
  const candidates = await deezerCandidateSource({ deezer, cache }).candidates(
    relatedTo('Ada', 'Bex'),
    progress.onProgress,
  );

  assert.deepEqual(relatedCalls(deezer.calls), []);
  assert.deepEqual(progress.events, []);
  assert.deepEqual(candidates.map((c) => c.title).sort(), [
    'Night Bus',
    'Paper',
  ]);
});

test('graph entries older than 90 days are refreshed', async () => {
  const cache = tempCache();
  let now = Date.parse('2026-06-06');
  await deezerCandidateSource({
    deezer: fixtureDeezer(graphArtists()),
    cache,
    now: () => now,
  }).candidates(relatedTo('Ada', 'Bex'));

  now += 89 * DAY;
  const early = fixtureDeezer(graphArtists());
  await deezerCandidateSource({
    deezer: early,
    cache,
    now: () => now,
  }).candidates(relatedTo('Ada', 'Bex'));
  assert.deepEqual(relatedCalls(early.calls), []);

  now += 2 * DAY;
  const late = fixtureDeezer(graphArtists());
  await deezerCandidateSource({
    deezer: late,
    cache,
    now: () => now,
  }).candidates(relatedTo('Ada', 'Bex'));
  assert.deepEqual(relatedCalls(late.calls), [
    'relatedArtists 100',
    'relatedArtists 101',
  ]);
});

test('a seed Deezer lacks is cached as not on Deezer', async () => {
  const cache = tempCache();
  const progress = recordingProgress();
  await deezerCandidateSource({
    deezer: fixtureDeezer(graphArtists()),
    cache,
    now: () => Date.parse('2026-06-06'),
  }).candidates(relatedTo('Ada', 'Ghost'), progress.onProgress);

  const graph = await cache.load(RELATED_ARTIST_GRAPH);
  assert.deepEqual(graph?.['sp-Ghost'], {
    deezerId: null,
    related: [],
    fetchedAt: Date.parse('2026-06-06'),
  });
  // Not on Deezer is an answer, not a failure.
  assert.ok(!progress.events.some((e) => e.phase === 'related-artists-failed'));
});

for (const what of ['searchArtist', 'relatedArtists'] as const) {
  test(`a failed ${what} for a seed is never cached and is reported`, async () => {
    const cache = tempCache();
    const failing = fixtureDeezer(graphArtists());
    failing.fail(what, 'Bex');
    const progress = recordingProgress();
    const first = await deezerCandidateSource({
      deezer: failing,
      cache,
    }).candidates(relatedTo('Ada', 'Bex', 'Cy'), progress.onProgress);

    // Nova is still named by Ada and Cy; Quill lost Bex.
    assert.deepEqual(
      first.map((c) => c.title),
      ['Night Bus'],
    );
    assert.deepEqual(progress.events.at(-1), {
      phase: 'related-artists-failed',
      seeds: 1,
    });
    assert.equal(
      (await cache.load(RELATED_ARTIST_GRAPH))?.['sp-Bex'],
      undefined,
    );

    const deezer = fixtureDeezer(graphArtists());
    const second = await deezerCandidateSource({ deezer, cache }).candidates(
      relatedTo('Ada', 'Bex', 'Cy'),
    );
    assert.deepEqual(relatedCalls(deezer.calls), ['relatedArtists 101']);
    assert.deepEqual(second.map((c) => c.title).sort(), ['Night Bus', 'Paper']);
  });
}

test('a stale entry survives a failed refresh', async () => {
  const cache = tempCache();
  let now = Date.parse('2026-06-06');
  await deezerCandidateSource({
    deezer: fixtureDeezer(graphArtists()),
    cache,
    now: () => now,
  }).candidates(relatedTo('Ada', 'Bex'));

  now += 100 * DAY;
  const failing = fixtureDeezer(graphArtists());
  failing.fail('relatedArtists', 'Bex');
  const progress = recordingProgress();
  const candidates = await deezerCandidateSource({
    deezer: failing,
    cache,
    now: () => now,
  }).candidates(relatedTo('Ada', 'Bex'), progress.onProgress);

  assert.deepEqual(candidates.map((c) => c.title).sort(), [
    'Night Bus',
    'Paper',
  ]);
  assert.deepEqual(progress.events.at(-1), {
    phase: 'related-artists-failed',
    seeds: 1,
  });
  assert.equal(
    (await cache.load(RELATED_ARTIST_GRAPH))?.['sp-Bex']?.fetchedAt,
    Date.parse('2026-06-06'),
  );
});

test("co-citation follows the current seeds; a demoted seed's entry is ignored, not deleted", async () => {
  const cache = tempCache();
  await deezerCandidateSource({
    deezer: fixtureDeezer(graphArtists()),
    cache,
  }).candidates(relatedTo('Ada', 'Bex', 'Cy'));

  // Bex demoted: Quill is named by Ada alone now.
  const withoutBex = await deezerCandidateSource({
    deezer: fixtureDeezer(graphArtists()),
    cache,
  }).candidates(relatedTo('Ada', 'Cy'));
  assert.deepEqual(
    withoutBex.map((c) => [c.title, c.provenance]),
    [['Night Bus', [{ kind: 'related', to: ['Ada', 'Cy'] }]]],
  );
  assert.ok((await cache.load(RELATED_ARTIST_GRAPH))?.['sp-Bex']);

  // Bex back: no fetch needed.
  const deezer = fixtureDeezer(graphArtists());
  await deezerCandidateSource({ deezer, cache }).candidates(
    relatedTo('Ada', 'Bex', 'Cy'),
  );
  assert.deepEqual(relatedCalls(deezer.calls), []);
});

test('later weeks of one fill reuse the graph and fetch only newly promoted seeds', async () => {
  const deezer = fixtureDeezer(graphArtists());
  const source = deezerCandidateSource({ deezer, cache: tempCache() });

  await source.candidates(relatedTo('Ada', 'Bex'));
  await source.candidates(relatedTo('Ada', 'Bex'));
  await source.candidates(relatedTo('Ada', 'Bex', 'Cy'));

  assert.deepEqual(relatedCalls(deezer.calls), [
    'relatedArtists 100',
    'relatedArtists 101',
    'relatedArtists 102',
  ]);
});

test('a seed that failed is not retried in later weeks of the same fill', async () => {
  const deezer = fixtureDeezer(graphArtists());
  deezer.fail('relatedArtists', 'Bex');
  const source = deezerCandidateSource({ deezer, cache: tempCache() });

  await source.candidates(relatedTo('Ada', 'Bex'));
  deezer.heal('Bex');
  const progress = recordingProgress();
  await source.candidates(relatedTo('Ada', 'Bex'), progress.onProgress);

  assert.deepEqual(relatedCalls(deezer.calls), [
    'relatedArtists 100',
    'relatedArtists 101',
  ]);
  assert.deepEqual(progress.events, []);
});

test('stopping during the top-up saves the graph so far and the next fill resumes', async () => {
  const cache = tempCache();
  let checks = 0;
  await assert.rejects(
    deezerCandidateSource({
      deezer: fixtureDeezer(graphArtists()),
      cache,
      checkAbort: () => {
        if (++checks > 2) throw new TaskAborted();
      },
    }).candidates(relatedTo('Ada', 'Bex', 'Cy')),
    TaskAborted,
  );

  const deezer = fixtureDeezer(graphArtists());
  const progress = recordingProgress();
  await deezerCandidateSource({ deezer, cache }).candidates(
    relatedTo('Ada', 'Bex', 'Cy'),
    progress.onProgress,
  );
  assert.deepEqual(relatedCalls(deezer.calls), ['relatedArtists 102']);
  assert.deepEqual(progress.events.at(-1), {
    phase: 'related-artists',
    done: 1,
    total: 1,
  });
});

test('the graph is saved every 50 seeds during a top-up', async () => {
  const many = Array.from({ length: 120 }, (_, i) =>
    seedArtist(1000 + i, `S${i}`, []),
  );
  const inner = tempCache();
  const saved: number[] = [];
  const cache: DurableCache = {
    ...inner,
    async save(descriptor, value) {
      if (descriptor === RELATED_ARTIST_GRAPH) {
        saved.push(Object.keys(value as object).length);
      }
      await inner.save(descriptor, value);
    },
  };

  await deezerCandidateSource({
    deezer: fixtureDeezer(many),
    cache,
  }).candidates(relatedTo(...many.map((a) => a.name)));

  assert.deepEqual(saved, [50, 100, 120]);
});

test('the graph is not mirrored to the browser, and a Redis failure leaves the file authoritative', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidates-test-'));
  const mirrored: string[] = [];
  const cache = createDurableCache({
    userId: 'user-1',
    dataDir,
    redis: {
      get: async () => null,
      set: async () => {
        throw new Error('ERR max request size exceeded');
      },
      del: async () => {},
    },
    onSave: (descriptor) => mirrored.push(descriptor.redisName),
  });

  await deezerCandidateSource({
    deezer: fixtureDeezer(graphArtists()),
    cache,
  }).candidates(relatedTo('Ada', 'Bex'));

  assert.ok(!mirrored.includes('relatedArtistGraph'));
  assert.deepEqual(
    Object.keys((await cache.load(RELATED_ARTIST_GRAPH)) ?? {}).sort(),
    ['sp-Ada', 'sp-Bex'],
  );
});
