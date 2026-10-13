import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureGateway } from '../lib/spotify/fixture.js';
import { spotifyReleaseReads } from '../services/week-collection/spotify-reads.js';

// ── Fake SDK ────────────────────────────────────────────────────────────────

const simplifiedAlbum = (id: string, overrides: object = {}) => ({
  id,
  name: 'Record',
  album_type: 'album',
  release_date: '2026-06-05',
  available_markets: ['US', 'GB'],
  total_tracks: 9,
  artists: [{ id: 'art-1', name: 'Artist' }],
  ...overrides,
});

// ── searchByUpc ─────────────────────────────────────────────────────────────

test('searchByUpc searches albums by barcode and returns the match', async () => {
  const queries: Array<{ q: string; types: string[] }> = [];
  const api = {
    async search(q: string, types: string[]) {
      queries.push({ q, types });
      return { albums: { items: [simplifiedAlbum('alb-1')] } };
    },
  };
  const reads = spotifyReleaseReads(fixtureGateway(api));

  const album = await reads.searchByUpc('0602445123456');

  assert.deepEqual(queries, [{ q: 'upc:0602445123456', types: ['album'] }]);
  assert.deepEqual(album, {
    id: 'alb-1',
    name: 'Record',
    type: 'album',
    release_date: '2026-06-05',
    markets: 2,
    artists: [{ id: 'art-1', name: 'Artist' }],
  });
});

test('searchByUpc returns null when no album has the barcode', async () => {
  const api = {
    async search() {
      return { albums: { items: [] } };
    },
  };
  const reads = spotifyReleaseReads(fixtureGateway(api));
  assert.equal(await reads.searchByUpc('0000000000000'), null);
});

test('searchByUpc returns null when the search fails', async () => {
  const api = {
    async search() {
      throw new Error('502');
    },
  };
  const reads = spotifyReleaseReads(fixtureGateway(api));
  assert.equal(await reads.searchByUpc('0602445123456'), null);
});

// ── playlistAlbums ──────────────────────────────────────────────────────────

test('playlistAlbums keeps each album once, with its date, artists, type and size', async () => {
  const track = (albumId: string, overrides: object = {}) => ({
    track: {
      album: simplifiedAlbum(albumId, overrides),
      artists: [{ id: 'art-1', name: 'Artist' }],
    },
  });
  const api = {
    playlists: {
      async getPlaylistItems() {
        return {
          items: [
            track('alb-1', {
              artists: [
                { id: 'art-1', name: 'Artist' },
                { id: 'art-2', name: 'Guest' },
              ],
            }),
            track('alb-1'),
            track('alb-2', {
              name: 'Single',
              album_type: 'single',
              release_date: '2026-06',
              total_tracks: 1,
            }),
          ],
          next: null,
        };
      },
    },
  };
  const reads = spotifyReleaseReads(fixtureGateway(api));

  const albums = await reads.playlistAlbums('pl-1');

  assert.deepEqual(
    [...albums.values()],
    [
      {
        id: 'alb-1',
        name: 'Record',
        artistName: 'Artist',
        artistIds: ['art-1', 'art-2'],
        releaseDate: '2026-06-05',
        albumType: 'album',
        totalTracks: 9,
      },
      {
        id: 'alb-2',
        name: 'Single',
        artistName: 'Artist',
        artistIds: ['art-1'],
        releaseDate: '2026-06',
        albumType: 'single',
        totalTracks: 1,
      },
    ],
  );
});
