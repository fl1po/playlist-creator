import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { fixtureGateway } from '../lib/spotify/fixture.js';
import type { SpotifyGateway } from '../lib/spotify/gateway.js';
import { AI_PICKS, localUserData } from '../lib/user-data/index.js';
import type { UserSession } from '../lib/user-session.js';
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
  return { ctx: fixtureGateway(api), removed };
}

/** A session over `ctx`, with user data in a temp dir. */
function session(t: TestContext, ctx: SpotifyGateway): UserSession {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { gateway: ctx, userId: 'user-1', data: localUserData(dataDir) };
}

const uris = (n: number) =>
  Array.from({ length: n }, (_, i) => `spotify:track:t${i}`);

// ── Tests ───────────────────────────────────────────────────────────────────

test('clears every track in batches of 100', async (t) => {
  const { ctx, removed } = fakeContext({ trackUris: uris(130) });

  const result = await new PlaylistClearerService(session(t, ctx)).clear(
    'Target',
  );

  assert.equal(result.cleared, 130);
  assert.deepEqual(
    removed.map((b) => b.length),
    [100, 30],
  );
});

test('removes local files and episodes by their own URI', async (t) => {
  const local = 'spotify:local:Artist:Album:Song:180';
  const { ctx, removed } = fakeContext({ trackUris: [local] });

  await new PlaylistClearerService(session(t, ctx)).clear('Target');

  assert.deepEqual(removed, [[local]]);
});

test('a failed removal throws and says how far it got', async (t) => {
  const { ctx } = fakeContext({ trackUris: uris(130), failRemoveBatch: 1 });
  let cleared = false;
  const service = new PlaylistClearerService(session(t, ctx), (e) => {
    if (e.kind === 'cleared') cleared = true;
  });

  await assert.rejects(service.clear('Target'), /100 of 130 removed/);
  assert.equal(cleared, false);
});

test('a failed track read throws instead of clearing a partial list', async (t) => {
  const { ctx, removed } = fakeContext({ trackUris: uris(5), failItems: true });

  await assert.rejects(
    new PlaylistClearerService(session(t, ctx)).clear('Target'),
    /read tracks/,
  );
  assert.deepEqual(removed, []);
});

test('a failed playlist listing throws instead of reporting "not found"', async (t) => {
  const { ctx } = fakeContext({ trackUris: [], failListing: true });
  let notFound = false;
  const service = new PlaylistClearerService(session(t, ctx), (e) => {
    if (e.kind === 'not-found') notFound = true;
  });

  await assert.rejects(service.clear('Target'), /list playlists/);
  assert.equal(notFound, false);
});

// ── Forgetting AI picks ─────────────────────────────────────────────────────

test("a clear forgets the cleared playlist's AI picks", async (t) => {
  const { ctx } = fakeContext({ trackUris: uris(2) });
  const s = session(t, ctx);
  await s.data.save(AI_PICKS, {
    Target: { skipped: 'over-budget' },
    Other: { picks: [] },
  });

  await new PlaylistClearerService(s).clear('Target');

  assert.deepEqual(await s.data.load(AI_PICKS), { Other: { picks: [] } });
});

test('a failed clear keeps the AI picks', async (t) => {
  const { ctx } = fakeContext({ trackUris: uris(2), failItems: true });
  const s = session(t, ctx);
  await s.data.save(AI_PICKS, { Target: { skipped: 'over-budget' } });

  await assert.rejects(new PlaylistClearerService(s).clear('Target'));

  assert.deepEqual(await s.data.load(AI_PICKS), {
    Target: { skipped: 'over-budget' },
  });
});
