import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceEmitter } from '../lib/service-events.js';
import type { SpotifyContext } from '../lib/spotify-context.js';
import type { TrustedArtistsFile } from '../lib/types.js';
import {
  type DatePipelineDeps,
  processDate,
} from '../services/playlist-filler/date-pipeline.js';
import {
  fixedPopularitySource,
  memoryCheckpoints,
} from '../services/week-collection/adapters.js';
import type { ReleaseReads } from '../services/week-collection/index.js';

// A single P1 artist with one in-window, one-track release — the minimal
// catalog that makes `processDate` reach the playlist-track-write step.
const WEEK = '05.06.26';
const IN_WINDOW = '2026-06-05';

function fixtureReads(): ReleaseReads {
  return {
    async searchArtist(name) {
      return name === 'Alpha' ? { id: 'art-a', name: 'Alpha' } : null;
    },
    async artistAlbums(artistId) {
      if (artistId !== 'art-a') return [];
      return [
        {
          id: 'alb-x',
          name: 'X',
          type: 'album',
          release_date: IN_WINDOW,
          markets: 5,
        },
      ];
    },
    async albumDetails(albumId) {
      if (albumId !== 'alb-x') return null;
      return {
        id: 'alb-x',
        name: 'X',
        type: 'album',
        release_date: IN_WINDOW,
        explicit: false,
        markets: 5,
        artists: [{ id: 'art-a', name: 'Alpha' }],
      };
    },
    async albumTracks(albumId) {
      if (albumId !== 'alb-x') return [];
      return [{ id: 't1', name: 'One', key: 'alpha::one' }];
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
}

function trusted(): TrustedArtistsFile {
  return { artistCounts: {} } as unknown as TrustedArtistsFile;
}

function fakeCtx(opts: { failAddWith?: Error } = {}): SpotifyContext {
  const api = {
    playlists: {
      createPlaylist: async (_userId: string, info: { name: string }) => ({
        id: 'pl-new',
        name: info.name,
        external_urls: { spotify: 'https://open.spotify.com/playlist/pl-new' },
      }),
      addItemsToPlaylist: async () => {
        if (opts.failAddWith) throw opts.failAddWith;
        return {};
      },
    },
  };
  return {
    api: api as unknown as SpotifyContext['api'],
    client: {} as SpotifyContext['client'],
    async call(fn) {
      try {
        return { success: true, data: await fn() };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    },
  };
}

function deps(ctx: SpotifyContext): DatePipelineDeps {
  return {
    ctx,
    emitter: new ServiceEmitter({}),
    ports: {
      reads: fixtureReads(),
      popularity: fixedPopularitySource({ 'alb-x': 70 }),
      checkpoints: memoryCheckpoints(),
    },
    config: {
      editorialPlaylists: [],
      externalPlaylistSources: [],
      editorialFilter: { minPopularity: 10, minFollowers: 100_000 },
    },
  };
}

test('processDate writes the collected tracks when the Spotify call succeeds', async () => {
  const result = await processDate(
    deps(fakeCtx()),
    WEEK,
    [['Alpha', { priority: 1, score: 100 }]],
    new Set(),
    'user-1',
    [],
    trusted(),
  );

  assert.equal(result.tracksAdded, 1);
  assert.equal(result.playlistId, 'pl-new');
});

test('processDate throws when writing collected tracks fails, instead of reporting success', async () => {
  const ctx = fakeCtx({ failAddWith: new Error('rate limited') });

  await assert.rejects(
    processDate(
      deps(ctx),
      WEEK,
      [['Alpha', { priority: 1, score: 100 }]],
      new Set(),
      'user-1',
      [],
      trusted(),
    ),
    /rate limited/,
  );
});
