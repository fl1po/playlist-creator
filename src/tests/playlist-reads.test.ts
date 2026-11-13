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
import { TaskAborted } from '../lib/spotify/errors.js';
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
  let onItemsPage: (() => void | Promise<void>) | null = null;

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
        await onItemsPage?.();
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
    /** Runs `fn` while the next item page is fetched; the page waits for it. */
    duringNextItemsPage(fn: () => void | Promise<void>) {
      onItemsPage = () => {
        onItemsPage = null;
        return fn();
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

test('a reader that joins a read in flight sees its progress', async (t) => {
  const { spotify, reads } = setup(t);
  spotify.set('aw', tracks('a', 60));
  const first: Array<[number, number]> = [];
  const joiner: Array<[number, number]> = [];
  let joined: Promise<PlaylistRead> | null = null;
  const join = async () => {
    joined = reads.tracks('aw', {
      onProgress: (fetched, total) => joiner.push([fetched, total]),
    });
    await new Promise((resolve) => setImmediate(resolve));
  };

  // The second reader joins after the first page has reported, and the
  // second page waits for it.
  await reads.tracks('aw', {
    onProgress: (fetched, total) => {
      first.push([fetched, total]);
      if (fetched === 50) spotify.duringNextItemsPage(join);
    },
  });
  await joined;

  assert.deepEqual(first, [
    [50, 60],
    [60, 60],
  ]);
  // It is told where the read already is, then follows it to the end.
  assert.deepEqual(joiner, [
    [50, 60],
    [60, 60],
  ]);
  const itemCalls = spotify.take().filter((c) => c.startsWith('items'));
  assert.deepEqual(itemCalls, ['items aw @0', 'items aw @50']);
});

test('a reader that stops while sharing a read fails alone', async (t) => {
  const { spotify, reads } = setup(t);
  spotify.set('aw', tracks('a', 60));
  const stopped = new Error('task stopped');
  let joined: Promise<PlaylistRead> | null = null;
  // The first page waits until the second reader has joined the read.
  spotify.duringNextItemsPage(async () => {
    joined = reads.tracks('aw', {
      onProgress: () => {
        throw stopped;
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
  });

  const read = await reads.tracks('aw', { onProgress: () => {} });

  assert.equal(ids(read).length, 60);
  await assert.rejects(joined as unknown as Promise<PlaylistRead>, stopped);
});

/** A second view of the same user data, on a gateway its own task can stop. */
function taskReads(spotify: ReturnType<typeof fakeSpotify>, data: UserData) {
  const stop = new AbortController();
  const reads = playlistReads({
    gateway: fixtureGateway(spotify.api, { signal: stop.signal }),
    data,
  });
  return { reads, stop: () => stop.abort(new TaskAborted()) };
}

function settledFlag(p: Promise<unknown>): () => boolean {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  return () => settled;
}

test('a reader stopped while sharing a read leaves it at once', async (t) => {
  const { spotify, reads, data } = setup(t);
  spotify.set('aw', tracks('a', 60));
  const task = taskReads(spotify, data);
  let taskRead: Promise<PlaylistRead> | null = null;
  let leftWhilePageHeld = false;
  // The first page hangs, as in a rate-limit wait, until the task has been
  // stopped and given a turn to leave.
  spotify.duringNextItemsPage(async () => {
    taskRead = task.reads.tracks('aw');
    const settled = settledFlag(taskRead);
    await new Promise((resolve) => setImmediate(resolve));
    task.stop();
    await new Promise((resolve) => setImmediate(resolve));
    leftWhilePageHeld = settled();
  });

  const read = await reads.tracks('aw');

  assert.ok(leftWhilePageHeld, 'the stopped reader waited for the page');
  await assert.rejects(
    taskRead as unknown as Promise<PlaylistRead>,
    TaskAborted,
  );
  assert.equal(ids(read).length, 60);
});

test('stopping the reader that started a shared read leaves it to the others', async (t) => {
  const { spotify, reads, data } = setup(t);
  spotify.set('aw', tracks('a', 120));
  const task = taskReads(spotify, data);
  let routeRead: Promise<PlaylistRead> | null = null;
  spotify.duringNextItemsPage(async () => {
    routeRead = reads.tracks('aw');
    await new Promise((resolve) => setImmediate(resolve));
    task.stop();
  });

  await assert.rejects(task.reads.tracks('aw'), TaskAborted);
  const read = await (routeRead as unknown as Promise<PlaylistRead>);

  assert.equal(ids(read).length, 120);
  const itemCalls = spotify.take().filter((c) => c.startsWith('items'));
  assert.deepEqual(itemCalls, ['items aw @0', 'items aw @50', 'items aw @100']);
});

test('a lone reader that stops ends the read and stores nothing', async (t) => {
  const { spotify, reads } = setup(t);
  spotify.set('aw', tracks('a', 120));
  const stopped = new Error('task stopped');

  await assert.rejects(
    reads.tracks('aw', {
      onProgress: () => {
        throw stopped;
      },
    }),
    stopped,
  );

  const itemCalls = spotify.take().filter((c) => c.startsWith('items'));
  assert.deepEqual(itemCalls, ['items aw @0']);
  const next = await reads.tracks('aw');
  assert.ok(next.success && !next.cached);
});

test('a lone reader stopped mid-read ends the read and stores nothing', async (t) => {
  const { spotify, data } = setup(t);
  spotify.set('aw', tracks('a', 120));
  const task = taskReads(spotify, data);
  spotify.duringNextItemsPage(() => task.stop());

  await assert.rejects(task.reads.tracks('aw'), TaskAborted);

  const itemCalls = spotify.take().filter((c) => c.startsWith('items'));
  assert.deepEqual(itemCalls, ['items aw @0']);
  const next = await playlistReads({
    gateway: fixtureGateway(spotify.api),
    data,
  }).tracks('aw');
  assert.ok(next.success && !next.cached);
});

test('a reader already stopped when it reaches the read fails alone', async (t) => {
  const { spotify, data } = setup(t);
  spotify.set('aw', tracks('a', 60));
  const task = taskReads(spotify, data);
  task.stop();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  // A held snapshot skips the live check, so nothing calls Spotify first.
  await assert.rejects(
    task.reads.tracks('aw', { snapshot: 'aw@1' }),
    TaskAborted,
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(unhandled, []);
  assert.deepEqual(spotify.take(), []);
});

test('a read everyone has left is not joined; the next reader starts afresh', async (t) => {
  const { spotify, reads, data } = setup(t);
  spotify.set('aw', tracks('a', 120));
  const task = taskReads(spotify, data);
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  let routeRead: Promise<PlaylistRead> | null = null;
  let laterRead: Promise<PlaylistRead> | null = null;
  // The lone task is stopped while its first page is still out, and a route
  // asks for the same playlist before that page comes back. Once the task's
  // read has ended, a later reader asks too, while the route's is still out.
  spotify.duringNextItemsPage(async () => {
    spotify.duringNextItemsPage(async () => {
      await turn();
      await turn();
      laterRead = reads.tracks('aw');
      await turn();
    });
    task.stop();
    routeRead = reads.tracks('aw');
    await turn();
  });

  await assert.rejects(task.reads.tracks('aw'), TaskAborted);
  const read = await (routeRead as unknown as Promise<PlaylistRead>);
  const later = await (laterRead as unknown as Promise<PlaylistRead>);

  assert.equal(ids(read).length, 120);
  assert.deepEqual(ids(later), ids(read));
  // The task's one page, then one read shared by the route and the later one.
  const itemCalls = spotify.take().filter((c) => c.startsWith('items'));
  assert.deepEqual(itemCalls, [
    'items aw @0',
    'items aw @0',
    'items aw @50',
    'items aw @100',
  ]);
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
