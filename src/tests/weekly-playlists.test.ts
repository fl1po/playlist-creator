import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { fixtureGateway } from '../lib/spotify/fixture.js';
import { localUserData } from '../lib/user-data/index.js';
import {
  memoryWeeklyPlaylistStore,
  spotifyWeeklyPlaylistStore,
} from '../services/weekly-playlists/adapters.js';
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
 * Runs the production store over a fake Spotify whose snapshot ids change on
 * every edit; `trackReads` lists each playlist whose items were fetched.
 */
function listeningWorld(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-playlists-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = localUserData(dir);

  const listed = [
    { id: 'pl-0', name: '29.08.25' },
    { id: 'pl-1', name: '05.09.25' },
    { id: 'pl-2', name: '12.09.25' },
    { id: 'pl-3', name: '19.09.25' },
    { id: 'pl-4', name: '26.09.25' },
    { id: 'pl-mix', name: 'Road trip' },
  ];
  const contents = new Map<string, string[]>(
    Object.entries({
      [AW]: ['a1', 'x1'],
      'pl-0': ['z1'],
      'pl-1': ['a1'],
      'pl-2': ['b1'],
      'pl-3': ['c1'],
      'pl-4': [],
      'pl-mix': ['c1'],
    }),
  );
  const versions = new Map<string, number>();
  const snapshot = (id: string) => `${id}@${versions.get(id) ?? 0}`;
  const edit = (id: string, trackIds: string[]) => {
    contents.set(id, trackIds);
    versions.set(id, (versions.get(id) ?? 0) + 1);
  };
  const trackReads: string[] = [];

  const api = {
    playlists: {
      async getUsersPlaylists(_user: string, limit: number, offset: number) {
        return {
          total: listed.length,
          items: listed.slice(offset, offset + limit).map((p) => ({
            ...p,
            owner: { id: USER },
            tracks: { total: contents.get(p.id)?.length ?? 0 },
            snapshot_id: snapshot(p.id),
          })),
        };
      },
      async getPlaylist(id: string) {
        return { snapshot_id: snapshot(id) };
      },
      async getPlaylistItems(
        id: string,
        _market: unknown,
        _fields: unknown,
        limit: number,
        offset: number,
      ) {
        if (offset === 0) trackReads.push(id);
        const ids = contents.get(id) ?? [];
        return {
          total: ids.length,
          items: ids.slice(offset, offset + limit).map((trackId) => ({
            added_at: '2025-09-01T00:00:00Z',
            track: { id: trackId, name: trackId, artists: [], album: {} },
          })),
        };
      },
      async addItemsToPlaylist(id: string, uris: string[]) {
        edit(id, [
          ...(contents.get(id) ?? []),
          ...uris.map((u) => u.replace('spotify:track:', '')),
        ]);
      },
    },
  };
  const store = spotifyWeeklyPlaylistStore({
    gateway: fixtureGateway(api),
    data,
  });

  const unprocessed = async () => {
    trackReads.length = 0;
    const { playlists } = await unprocessedWeeklyPlaylists(
      { store, userId: USER },
      AW,
    );
    return playlists.map((p) => p.name);
  };
  return { store, edit, trackReads, unprocessed };
}

test('unprocessed weekly playlists are the ones newer than the newest overlapping All Weekly, oldest first', async (t) => {
  const { trackReads, unprocessed } = listeningWorld(t);

  assert.deepEqual(await unprocessed(), ['12.09.25', '19.09.25']);
  // Nothing older than the cutoff is read, nor any empty or non-weekly playlist.
  assert.deepEqual(trackReads, [AW, 'pl-3', 'pl-2', 'pl-1']);
});

test('listening moves the cutoff without re-reading any weekly playlist', async (t) => {
  const { edit, trackReads, unprocessed } = listeningWorld(t);
  await unprocessed();

  edit(AW, ['a1', 'x1', 'b1']);

  assert.deepEqual(await unprocessed(), ['19.09.25']);
  assert.deepEqual(trackReads, [AW]);
});

test('a weekly playlist write re-reads only that playlist on the next listing', async (t) => {
  const { store, trackReads, unprocessed } = listeningWorld(t);
  await unprocessed();

  await weeklyPlaylists({ store, userId: USER }).write('26.09.25', ['d1']);

  assert.deepEqual(await unprocessed(), ['12.09.25', '19.09.25', '26.09.25']);
  assert.deepEqual(trackReads, ['pl-4']);
});

test('a cleared weekly playlist drops out of the next listing', async (t) => {
  const { edit, trackReads, unprocessed } = listeningWorld(t);
  await unprocessed();

  edit('pl-3', []);

  assert.deepEqual(await unprocessed(), ['12.09.25']);
  assert.deepEqual(trackReads, []);
});

test('an unchanged listing reads no playlist items at all', async (t) => {
  const { trackReads, unprocessed } = listeningWorld(t);
  await unprocessed();

  assert.deepEqual(await unprocessed(), ['12.09.25', '19.09.25']);
  assert.deepEqual(trackReads, []);
});
