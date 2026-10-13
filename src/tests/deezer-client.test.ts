import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DeezerClient } from '../lib/deezer-client.js';

// ── Fake Deezer ─────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer every request with `respond(path)`: a JSON body, a status, or a throw. */
function fakeDeezer(
  respond: (path: string) => { status?: number; body?: unknown } | 'offline',
) {
  globalThis.fetch = (async (url: string | URL) => {
    const path = String(url).replace('https://api.deezer.com', '');
    const answer = respond(path);
    if (answer === 'offline') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
    });
  }) as typeof fetch;
}

const artist = (id: number, name: string, nb_fan = 1000) => ({
  id,
  name,
  nb_fan,
});

// ── relatedArtists ──────────────────────────────────────────────────────────

test('relatedArtists returns the related artists', async () => {
  fakeDeezer(() => ({ body: { data: [artist(2, 'Neighbour')] } }));
  const related = await new DeezerClient().relatedArtists(1);
  assert.deepEqual(related, [artist(2, 'Neighbour')]);
});

test('relatedArtists returns an empty list when the artist has none', async () => {
  fakeDeezer(() => ({ body: { data: [] } }));
  assert.deepEqual(await new DeezerClient().relatedArtists(1), []);
});

test('relatedArtists returns null on an HTTP failure', async () => {
  fakeDeezer(() => ({ status: 500 }));
  assert.equal(await new DeezerClient().relatedArtists(1), null);
});

test('relatedArtists returns null on a Deezer error body', async () => {
  fakeDeezer(() => ({ body: { error: { type: 'Exception', code: 800 } } }));
  assert.equal(await new DeezerClient().relatedArtists(1), null);
});

test('relatedArtists returns null when Deezer is unreachable', async () => {
  fakeDeezer(() => 'offline');
  assert.equal(await new DeezerClient().relatedArtists(1), null);
});

// ── searchArtist ────────────────────────────────────────────────────────────

test('searchArtist resolves the most-followed exact name match', async () => {
  fakeDeezer(() => ({
    body: {
      data: [
        artist(1, 'Chlöe', 7),
        artist(2, 'Chloe Tribute'),
        artist(3, 'Chlöe', 900_000),
      ],
    },
  }));
  const found = await new DeezerClient().searchArtist('Chloe');
  assert.deepEqual(found, artist(3, 'Chlöe', 900_000));
});

test('searchArtist reports not-found when no hit matches the name', async () => {
  fakeDeezer(() => ({ body: { data: [artist(2, 'Somebody Else')] } }));
  assert.equal(await new DeezerClient().searchArtist('Nobody'), 'not-found');
});

test('searchArtist reports not-found when the search is empty', async () => {
  fakeDeezer(() => ({ body: { data: [] } }));
  assert.equal(await new DeezerClient().searchArtist('Nobody'), 'not-found');
});

test('searchArtist returns null on an HTTP failure', async () => {
  fakeDeezer(() => ({ status: 503 }));
  assert.equal(await new DeezerClient().searchArtist('Anyone'), null);
});

test('searchArtist returns null when Deezer is unreachable', async () => {
  fakeDeezer(() => 'offline');
  assert.equal(await new DeezerClient().searchArtist('Anyone'), null);
});

// ── getAlbum ────────────────────────────────────────────────────────────────

test('getAlbum exposes the barcode', async () => {
  fakeDeezer(() => ({
    body: {
      id: 10,
      title: 'Record',
      upc: '0602445123456',
      fans: 5,
      release_date: '2026-06-05',
      record_type: 'album',
      explicit_lyrics: false,
      tracks: { data: [] },
    },
  }));
  const album = await new DeezerClient().getAlbum(10);
  assert.equal(album?.upc, '0602445123456');
});

// ── artistAlbums ────────────────────────────────────────────────────────────

const listed = (id: number, release_date: string) => ({
  id,
  title: `Album ${id}`,
  record_type: 'single',
  release_date,
});

test('artistAlbums lists the artist releases', async () => {
  let asked = '';
  fakeDeezer((path) => {
    asked = path;
    return { body: { data: [listed(10, '2026-06-05')] } };
  });
  const albums = await new DeezerClient().artistAlbums(7);
  assert.deepEqual(albums, [listed(10, '2026-06-05')]);
  assert.equal(asked, '/artist/7/albums?limit=100');
});

test('artistAlbums returns an empty list when the artist has none', async () => {
  fakeDeezer(() => ({ body: { data: [] } }));
  assert.deepEqual(await new DeezerClient().artistAlbums(7), []);
});

test('artistAlbums returns null when the lookup fails', async () => {
  fakeDeezer(() => ({ status: 500 }));
  assert.equal(await new DeezerClient().artistAlbums(7), null);
  fakeDeezer(() => 'offline');
  assert.equal(await new DeezerClient().artistAlbums(7), null);
});

// ── topTracks ───────────────────────────────────────────────────────────────

test('topTracks returns each top track rank and album', async () => {
  let asked = '';
  fakeDeezer((path) => {
    asked = path;
    return {
      body: {
        data: [{ id: 1, title: 'Hit', rank: 500_000, album: { id: 9 } }],
      },
    };
  });
  const top = await new DeezerClient().topTracks(7);
  assert.deepEqual(top, [{ album: 9, rank: 500_000 }]);
  assert.equal(asked, '/artist/7/top?limit=10');
});

test('topTracks returns null when the lookup fails', async () => {
  fakeDeezer(() => ({ body: { error: { type: 'Exception', code: 800 } } }));
  assert.equal(await new DeezerClient().topTracks(7), null);
  fakeDeezer(() => 'offline');
  assert.equal(await new DeezerClient().topTracks(7), null);
});
