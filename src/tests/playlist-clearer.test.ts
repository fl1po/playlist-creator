import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SpotifyContext } from '../lib/spotify-context.js';
import { PlaylistClearerService } from '../services/playlist-clearer.js';

// ── Fixture: one playlist on a fake Spotify, with injectable failures ───────

function fakeContext(opts: {
  trackUris: string[];
  failListing?: boolean;
  failItems?: boolean;
  failRemoveBatch?: number;
}) {
  const removed: string[][] = [];
  let removeCalls = 0;
  const api = {
    currentUser: {
      playlists: {
        playlists: async () => {
          if (opts.failListing) throw new Error('boom');
          return {
            items: [
              {
                id: 'p1',
                name: 'Target',
                tracks: { total: opts.trackUris.length },
              },
            ],
          };
        },
      },
    },
    playlists: {
      getPlaylistItems: async (
        _id: string,
        _m: unknown,
        _f: unknown,
        limit: number,
        offset: number,
      ) => {
        if (opts.failItems) throw new Error('boom');
        return {
          items: opts.trackUris
            .slice(offset, offset + limit)
            .map((uri) => ({ track: { uri } })),
        };
      },
      removeItemsFromPlaylist: async (
        _id: string,
        body: { tracks: Array<{ uri: string }> },
      ) => {
        if (removeCalls++ === opts.failRemoveBatch) throw new Error('boom');
        removed.push(body.tracks.map((t) => t.uri));
        return { snapshot_id: 's' };
      },
    },
  };
  const ctx = {
    api,
    call: async <T>(fn: () => Promise<T>) => {
      try {
        return { success: true, data: await fn() };
      } catch (error) {
        return { success: false, error };
      }
    },
  } as unknown as SpotifyContext;
  return { ctx, removed };
}

const uris = (n: number) =>
  Array.from({ length: n }, (_, i) => `spotify:track:t${i}`);

// ── Tests ───────────────────────────────────────────────────────────────────

test('clears every track in batches of 100', async () => {
  const { ctx, removed } = fakeContext({ trackUris: uris(130) });

  const result = await new PlaylistClearerService(ctx).clear('Target');

  assert.equal(result.cleared, 130);
  assert.deepEqual(
    removed.map((b) => b.length),
    [100, 30],
  );
});

test('removes local files and episodes by their own URI', async () => {
  const local = 'spotify:local:Artist:Album:Song:180';
  const { ctx, removed } = fakeContext({ trackUris: [local] });

  await new PlaylistClearerService(ctx).clear('Target');

  assert.deepEqual(removed, [[local]]);
});

test('a failed removal throws and says how far it got', async () => {
  const { ctx } = fakeContext({ trackUris: uris(130), failRemoveBatch: 1 });
  let cleared = false;
  const service = new PlaylistClearerService(ctx, {
    onCleared: () => {
      cleared = true;
    },
  });

  await assert.rejects(service.clear('Target'), /100 of 130 removed/);
  assert.equal(cleared, false);
});

test('a failed track read throws instead of clearing a partial list', async () => {
  const { ctx, removed } = fakeContext({ trackUris: uris(5), failItems: true });

  await assert.rejects(
    new PlaylistClearerService(ctx).clear('Target'),
    /read tracks/,
  );
  assert.deepEqual(removed, []);
});

test('a failed playlist listing throws instead of reporting "not found"', async () => {
  const { ctx } = fakeContext({ trackUris: [], failListing: true });
  let notFound = false;
  const service = new PlaylistClearerService(ctx, {
    onPlaylistNotFound: () => {
      notFound = true;
    },
  });

  await assert.rejects(service.clear('Target'), /list playlists/);
  assert.equal(notFound, false);
});
