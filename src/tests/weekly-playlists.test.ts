import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryWeeklyPlaylistStore } from '../services/weekly-playlists/adapters.js';
import { findWeeklyPlaylist } from '../services/weekly-playlists/index.js';

// ── The weekly playlist for a date ──────────────────────────────────────────

const USER = 'user-1';

test("a date's weekly playlist is found by its date", async () => {
  const store = memoryWeeklyPlaylistStore([
    { id: 'pl-a', name: '26.12.25', trackCount: 4 },
    { id: 'pl-b', name: '02.01.26', trackCount: 7 },
  ]);

  const playlist = await findWeeklyPlaylist(store, USER, '02.01.26');

  assert.deepEqual(playlist, { id: 'pl-b', name: '02.01.26', trackCount: 7 });
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
