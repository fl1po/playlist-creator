import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  localUserData,
  WEEKLY_PLAYLIST_TRACKS,
} from '../lib/user-data/index.js';
import { memoryWeeklyPlaylistStore } from '../services/weekly-playlists/adapters.js';
import {
  findWeeklyPlaylist,
  unprocessedWeeklyPlaylists,
  weeklyPlaylists,
} from '../services/weekly-playlists/index.js';

// ── The weekly playlist for a date ──────────────────────────────────────────

const USER = 'user-1';

test("a date's weekly playlist is found by its date", async () => {
  const store = memoryWeeklyPlaylistStore([
    { id: 'pl-a', name: '26.12.25', trackCount: 4 },
    { id: 'pl-b', name: '02.01.26', trackCount: 7 },
  ]);

  const playlist = await findWeeklyPlaylist(store, USER, '02.01.26');

  assert.equal(playlist?.id, 'pl-b');
});

test('a date with no weekly playlist finds none', async () => {
  const store = memoryWeeklyPlaylistStore([
    { id: 'pl-a', name: '26.12.25', trackCount: 4 },
  ]);

  assert.equal(await findWeeklyPlaylist(store, USER, '02.01.26'), null);
});

test('a playlist whose name only looks like the date is not its weekly playlist', async () => {
  const store = memoryWeeklyPlaylistStore([
    { id: 'pl-long', name: '02.01.2026', trackCount: 3 },
    { id: 'pl-short', name: '2.1.26', trackCount: 3 },
    { id: 'pl-suffix', name: '02.01.26 (copy)', trackCount: 3 },
  ]);

  assert.equal(await findWeeklyPlaylist(store, USER, '02.01.26'), null);
});

test('a date that is not a weekly name finds nothing, even a same-named playlist', async () => {
  const store = memoryWeeklyPlaylistStore([
    { id: 'pl-x', name: '2026-01-02', trackCount: 3 },
  ]);

  assert.equal(await findWeeklyPlaylist(store, USER, '2026-01-02'), null);
});

// ── Unprocessed weekly playlists ────────────────────────────────────────────

const AW = 'aw';

/**
 * Four weekly playlists, newest last; All Weekly holds a track of 05.09.25, so
 * that's the cutoff and the two after it are unprocessed. 26.09.25 is empty.
 */
function listeningWorld(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-playlists-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = localUserData(dir);
  const store = memoryWeeklyPlaylistStore(
    [
      { id: 'pl-0', name: '29.08.25', trackCount: 1 },
      { id: 'pl-1', name: '05.09.25', trackCount: 1 },
      { id: 'pl-2', name: '12.09.25', trackCount: 1 },
      { id: 'pl-3', name: '19.09.25', trackCount: 1 },
      { id: 'pl-4', name: '26.09.25', trackCount: 0 },
      { id: 'pl-mix', name: 'Road trip', trackCount: 1 },
    ],
    [],
    {
      [AW]: ['a1', 'x1'],
      'pl-0': ['z1'],
      'pl-1': ['a1'],
      'pl-2': ['b1'],
      'pl-3': ['c1'],
      'pl-mix': ['c1'],
    },
  );
  const unprocessed = async () => {
    store.trackReads.length = 0;
    const { playlists } = await unprocessedWeeklyPlaylists(
      { store, data, userId: USER },
      AW,
    );
    return playlists.map((p) => p.name);
  };
  return { store, data, unprocessed };
}

test('unprocessed weekly playlists are the ones newer than the newest overlapping All Weekly, oldest first', async (t) => {
  const { store, unprocessed } = listeningWorld(t);

  assert.deepEqual(await unprocessed(), ['12.09.25', '19.09.25']);
  // Nothing older than the cutoff is read, nor any empty or non-weekly playlist.
  assert.deepEqual(store.trackReads, [AW, 'pl-3', 'pl-2', 'pl-1']);
});

test('listening moves the cutoff without re-reading any weekly playlist', async (t) => {
  const { store, unprocessed } = listeningWorld(t);
  await unprocessed();

  store.edit(AW, ['a1', 'x1', 'b1']);

  assert.deepEqual(await unprocessed(), ['19.09.25']);
  assert.deepEqual(store.trackReads, [AW]);
});

test('a weekly playlist write re-reads only that playlist on the next listing', async (t) => {
  const { store, unprocessed } = listeningWorld(t);
  await unprocessed();

  await weeklyPlaylists({ store, userId: USER }).write('26.09.25', ['d1']);

  assert.deepEqual(await unprocessed(), ['12.09.25', '19.09.25', '26.09.25']);
  assert.deepEqual(store.trackReads, [AW, 'pl-4']);
});

test('a cleared weekly playlist drops out of the next listing', async (t) => {
  const { store, unprocessed } = listeningWorld(t);
  await unprocessed();

  store.edit('pl-3', []);

  assert.deepEqual(await unprocessed(), ['12.09.25']);
  assert.deepEqual(store.trackReads, [AW]);
});

test('only the playlists the last listing walked are kept', async (t) => {
  const { store, data, unprocessed } = listeningWorld(t);
  await unprocessed();
  assert.deepEqual(
    Object.keys((await data.load(WEEKLY_PLAYLIST_TRACKS)) ?? {}).sort(),
    ['pl-1', 'pl-2', 'pl-3'],
  );

  store.edit(AW, ['a1', 'x1', 'c1']);
  await unprocessed();

  assert.deepEqual(
    Object.keys((await data.load(WEEKLY_PLAYLIST_TRACKS)) ?? {}),
    ['pl-3'],
  );
});
