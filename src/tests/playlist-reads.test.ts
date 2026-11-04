import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  type PlaylistRead,
  PRUNE_AFTER_MS,
  playlistReads,
} from '../lib/playlist-reads/index.js';
import { fixtureGateway } from '../lib/spotify/fixture.js';
import {
  durableUserData,
  InMemoryRedisPort,
  localUserData,
  PLAYLIST_TRACKS,
  type UserData,
} from '../lib/user-data/index.js';

// ── Fixture: a fake Spotify that counts every call ──────────────────────────

interface RawItem {
  added_at: string;
  track: {
    id: string | null;
    uri: string;
    name: string;
    type?: string;
    is_local?: boolean;
    duration_ms: number;
    artists: Array<{ id: string; name: string }>;
    album: {
      id: string;
      name: string;
      release_date: string;
      artists: Array<{ name: string }>;
    };
  } | null;
}

function rawTrack(id: string, addedAt = '2026-01-01T00:00:00Z'): RawItem {
  return {
    added_at: addedAt,
    track: {
      id,
      uri: `spotify:track:${id}`,
      name: `Song ${id}`,
      duration_ms: 1000,
      artists: [{ id: `ar-${id}`, name: `Artist ${id}` }],
      album: {
        id: `al-${id}`,
        name: `Album ${id}`,
        release_date: '2026-01-01',
        artists: [{ name: `Artist ${id}` }],
      },
    },
  };
}

function tracks(prefix: string, n: number): RawItem[] {
  return Array.from({ length: n }, (_, i) => rawTrack(`${prefix}${i}`));
}

function fakeSpotify() {
  const playlists = new Map<string, { version: number; items: RawItem[] }>();
  let liked: RawItem[] = []; // newest first
  const calls: string[] = [];
  const failing = { snapshot: false, itemsAtOffset: -1 };
  let onItemsPage: (() => void) | null = null;

  const api = {
    playlists: {
      async getPlaylist(id: string) {
        calls.push(`snapshot ${id}`);
        if (failing.snapshot) throw new Error('spotify 500');
        const pl = playlists.get(id);
        return { snapshot_id: `${id}@${pl?.version ?? 0}` };
      },
      async getPlaylistItems(
        id: string,
        _market: unknown,
        _fields: unknown,
        limit: number,
        offset: number,
      ) {
        calls.push(`items ${id} @${offset}`);
        if (offset === failing.itemsAtOffset) throw new Error('spotify 502');
        onItemsPage?.();
        const items = playlists.get(id)?.items ?? [];
        return {
          total: items.length,
          items: items.slice(offset, offset + limit),
        };
      },
    },
    currentUser: {
      tracks: {
        async savedTracks(limit: number, offset: number) {
          calls.push(`liked ${limit}@${offset}`);
          return {
            total: liked.length,
            items: liked.slice(offset, offset + limit),
          };
        },
      },
    },
  };

  return {
    api,
    calls,
    failing,
    set(id: string, items: RawItem[]) {
      const pl = playlists.get(id);
      playlists.set(id, { version: (pl?.version ?? 0) + 1, items });
    },
    setLiked(items: RawItem[]) {
      liked = items;
    },
    duringNextItemsPage(fn: () => void) {
      onItemsPage = () => {
        onItemsPage = null;
        fn();
      };
    },
    /** Calls since the last `take`. */
    take(): string[] {
      return calls.splice(0);
    },
  };
}

function tmpData(t: TestContext): { dir: string; data: () => UserData } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playlist-reads-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A fresh UserData is a fresh process: nothing held in memory.
  return { dir, data: () => localUserData(dir) };
}

function setup(t: TestContext) {
  const spotify = fakeSpotify();
  const store = tmpData(t);
  const data = store.data();
  const reads = playlistReads({ gateway: fixtureGateway(spotify.api), data });
  return { spotify, reads, store, data };
}

function ids(read: PlaylistRead): Array<string | null> {
  assert.ok(read.success, 'read failed');
  return read.items.map((i) => i.track?.id ?? null);
}

// ── Playlists ────────────────────────────────────────────────────────────────

test('a cold read fetches every page and keeps the playlist order', async (t) => {
  const { spotify, reads } = setup(t);
  spotify.set('aw', tracks('a', 120));

  const read = await reads.tracks('aw');

  assert.ok(read.success);
  assert.equal(read.cached, false);
  assert.equal(read.snapshot, 'aw@1');
  assert.deepEqual(
    ids(read),
    tracks('a', 120).map((r) => r.track?.id),
  );
  assert.deepEqual(spotify.take(), [
    'snapshot aw',
    'items aw @0',
    'items aw @50',
    'items aw @100',
    'snapshot aw',
  ]);
});

test('an unchanged snapshot costs exactly one call', async (t) => {
  const { spotify, reads } = setup(t);
  spotify.set('aw', tracks('a', 120));
  await reads.tracks('aw');
  spotify.take();

  const read = await reads.tracks('aw');

  assert.ok(read.success);
  assert.equal(read.cached, true);
  assert.equal(read.items.length, 120);
  assert.deepEqual(spotify.take(), ['snapshot aw']);
});

test('the stored copy outlives the process', async (t) => {
  const { spotify, reads, store } = setup(t);
  spotify.set('aw', tracks('a', 60));
  const first = await reads.tracks('aw');
  spotify.take();

  const later = playlistReads({
    gateway: fixtureGateway(spotify.api),
    data: store.data(),
  });
  const read = await later.tracks('aw');

  assert.ok(read.success && read.cached);
  assert.deepEqual(read.items, first.success ? first.items : null);
  assert.deepEqual(spotify.take(), ['snapshot aw']);
});

test('a snapshot the caller already holds costs no calls', async (t) => {
  const { spotify, reads } = setup(t);
  spotify.set('wk', tracks('w', 3));
  await reads.tracks('wk');
  spotify.take();

  const read = await reads.tracks('wk', { snapshot: 'wk@1' });

  assert.ok(read.success && read.cached);
  assert.deepEqual(spotify.take(), []);
});

test('any edit changes the snapshot and the playlist is read again', async (t) => {
  const { spotify, reads } = setup(t);
  spotify.set('wk', tracks('w', 3));
  await reads.tracks('wk');
  spotify.set('wk', tracks('x', 2));
  spotify.take();

  const read = await reads.tracks('wk');

  assert.deepEqual(ids(read), ['x0', 'x1']);
  assert.deepEqual(spotify.take(), [
    'snapshot wk',
    'items wk @0',
    'snapshot wk',
  ]);
});

test('an unknown snapshot reads in full and stores nothing', async (t) => {
  const { spotify, reads } = setup(t);
  spotify.set('aw', tracks('a', 3));
  spotify.failing.snapshot = true;

  const read = await reads.tracks('aw');
  assert.ok(read.success);
  assert.equal(read.snapshot, null);
  assert.equal(read.items.length, 3);

  spotify.failing.snapshot = false;
  spotify.take();
  const next = await reads.tracks('aw');
  assert.ok(next.success && !next.cached);
});

test('a failed page fails the read and stores nothing', async (t) => {
  const { spotify, reads } = setup(t);
  spotify.set('aw', tracks('a', 120));
  spotify.failing.itemsAtOffset = 50;

  const read = await reads.tracks('aw');
  assert.equal(read.success, false);

  spotify.failing.itemsAtOffset = -1;
  const next = await reads.tracks('aw');
  assert.ok(next.success && !next.cached);
  assert.equal(next.items.length, 120);
});

test('a playlist edited while it is read is returned but not stored', async (t) => {
  const { spotify, reads } = setup(t);
  spotify.set('aw', tracks('a', 3));
  spotify.duringNextItemsPage(() => spotify.set('aw', tracks('a', 4)));

  const read = await reads.tracks('aw');
  assert.ok(read.success);
  assert.equal(read.snapshot, null);

  spotify.take();
  const next = await reads.tracks('aw');
  assert.ok(next.success && !next.cached);
  assert.equal(next.items.length, 4);
});

test('concurrent reads of one playlist share one fetch', async (t) => {
  const { spotify, reads } = setup(t);
  spotify.set('aw', tracks('a', 60));

  const [a, b] = await Promise.all([reads.tracks('aw'), reads.tracks('aw')]);

  assert.deepEqual(ids(a), ids(b));
  const itemCalls = spotify.take().filter((c) => c.startsWith('items'));
  assert.deepEqual(itemCalls, ['items aw @0', 'items aw @50']);
});

test('slots without a track are kept, with their uri', async (t) => {
  const { spotify, reads } = setup(t);
  const local = rawTrack('ignored');
  if (local.track) {
    local.track.id = null;
    local.track.is_local = true;
    local.track.uri = 'spotify:local:a:b:c:1';
  }
  spotify.set('aw', [rawTrack('t1'), local, { added_at: 'x', track: null }]);

  const read = await reads.tracks('aw');

  assert.ok(read.success);
  assert.deepEqual(
    read.items.map((i) => [i.track?.id ?? null, i.uri]),
    [
      ['t1', 'spotify:track:t1'],
      [null, 'spotify:local:a:b:c:1'],
      [null, null],
    ],
  );
  const track = read.items[0].track;
  assert.deepEqual(track, {
    id: 't1',
    name: 'Song t1',
    durationMs: 1000,
    artists: [{ id: 'ar-t1', name: 'Artist t1' }],
    album: {
      id: 'al-t1',
      name: 'Album t1',
      releaseDate: '2026-01-01',
      artistNames: ['Artist t1'],
    },
  });
});

test('entries nobody read for 30 days are pruned on the next store', async (t) => {
  const { spotify, store } = setup(t);
  const seeded = store.data();
  await seeded.save(PLAYLIST_TRACKS, {
    old: {
      snapshot: 'old@1',
      readAt: Date.now() - PRUNE_AFTER_MS - 1,
      items: [],
    },
    recent: { snapshot: 'recent@1', readAt: Date.now(), items: [] },
  });
  spotify.set('aw', tracks('a', 1));

  const data = store.data();
  await playlistReads({ gateway: fixtureGateway(spotify.api), data }).tracks(
    'aw',
  );

  assert.deepEqual(
    Object.keys((await data.load(PLAYLIST_TRACKS)) ?? {}).sort(),
    ['aw', 'recent'],
  );
});

// ── Liked Songs ──────────────────────────────────────────────────────────────

function likes(n: number, from = 0): RawItem[] {
  // Newest first: like i was added at minute i.
  return Array.from({ length: n }, (_, k) => {
    const i = from + n - 1 - k;
    return rawTrack(`l${i}`, `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`);
  });
}

test('Liked Songs: unchanged costs one call', async (t) => {
  const { spotify, reads } = setup(t);
  spotify.setLiked(likes(60));
  await reads.likedSongs();
  spotify.take();

  const read = await reads.likedSongs();

  assert.ok(read.success && read.cached);
  assert.equal(read.items.length, 60);
  assert.deepEqual(spotify.take(), ['liked 1@0']);
});

test('Liked Songs: a new like fetches only the newest page', async (t) => {
  const { spotify, reads } = setup(t);
  spotify.setLiked(likes(120));
  await reads.likedSongs();
  spotify.setLiked(likes(122));
  spotify.take();

  const read = await reads.likedSongs();

  assert.ok(read.success && !read.cached);
  assert.deepEqual(
    ids(read),
    likes(122).map((r) => r.track?.id),
  );
  assert.deepEqual(spotify.take(), ['liked 1@0', 'liked 50@0', 'liked 1@0']);
});

test('Liked Songs: an unlike shows in the count and costs a full read', async (t) => {
  const { spotify, reads } = setup(t);
  spotify.setLiked(likes(60));
  await reads.likedSongs();
  // Unlike an old song and like a new one: total is unchanged.
  const next = likes(61).filter((r) => r.track?.id !== 'l3');
  spotify.setLiked(next);
  spotify.take();

  const read = await reads.likedSongs();

  assert.deepEqual(
    ids(read),
    next.map((r) => r.track?.id),
  );
  const pages = spotify.take().filter((c) => c.startsWith('liked 50'));
  assert.deepEqual(pages, ['liked 50@0', 'liked 50@0', 'liked 50@50']);
});

// ── User data store: large Redis values ──────────────────────────────────────

test('large datasets round-trip through Redis compressed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playlist-reads-redis-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const redis = new InMemoryRedisPort();
  const data = durableUserData({ userId: 'u', dataDir: dir, redis });
  const big = {
    aw: {
      snapshot: 's',
      readAt: 1,
      items: Array.from({ length: 5000 }, (_, i) => ({
        i: `track-${i}`,
        n: 'x'.repeat(60),
      })),
    },
  };

  await data.save(PLAYLIST_TRACKS, big);
  const raw = await redis.get(`${PLAYLIST_TRACKS.name}:u`);
  assert.ok(raw?.startsWith('gz:'));

  fs.rmSync(dir, { recursive: true, force: true }); // a wiped disk
  const back = await durableUserData({ userId: 'u', dataDir: dir, redis }).load(
    PLAYLIST_TRACKS,
  );
  assert.deepEqual(back, big);
});
