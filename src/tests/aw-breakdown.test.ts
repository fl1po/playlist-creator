import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupTracksByWeek } from '../domain/aw-breakdown.js';
import type { PlaylistItem } from '../lib/playlist-reads/index.js';

function item(
  id: string,
  opts: { releaseDate?: string; addedAt?: string; albumId?: string } = {},
): PlaylistItem {
  const albumId = opts.albumId ?? `al-${id}`;
  return {
    uri: `spotify:track:${id}`,
    addedAt: opts.addedAt ?? null,
    track: {
      id,
      name: id,
      durationMs: 60_000,
      artists: [{ id: 'ar', name: 'Artist' }],
      album: {
        id: albumId,
        name: `Album ${albumId}`,
        releaseDate: opts.releaseDate ?? '',
        artistNames: ['Album Artist'],
      },
    },
  };
}

test('tracks group by their release Friday, falling back to the date added', () => {
  const weeks = groupTracksByWeek([
    // Wed 3 Sep 2025 → Fri 5 Sep; Fri 12 Sep stays.
    item('a', { releaseDate: '2025-09-03', addedAt: '2025-09-06T10:00:00Z' }),
    item('b', { releaseDate: '2025-09-12', addedAt: '2025-09-13T10:00:00Z' }),
    item('c', { addedAt: '2025-09-04T10:00:00Z' }),
  ]);

  assert.deepEqual(
    weeks.map((w) => [w.date, w.trackCount, w.durationMs]),
    [
      ['05.09.25', 2, 120_000],
      ['12.09.25', 1, 60_000],
    ],
  );
});

test('slots without a track are skipped, and undated tracks join the latest week', () => {
  const weeks = groupTracksByWeek([
    item('a', { releaseDate: '2025-09-12' }),
    { track: null, uri: 'spotify:local:x', addedAt: null },
    item('b'),
  ]);

  assert.deepEqual(
    weeks.map((w) => [w.date, w.trackCount]),
    [['12.09.25', 2]],
  );
});

test('an album with three or more tracks in a week counts as an album', () => {
  const weeks = groupTracksByWeek(
    ['1', '2', '3'].map((n) =>
      item(`t${n}`, { releaseDate: '2025-09-12', albumId: 'lp' }),
    ),
  );

  assert.equal(weeks[0].albumCount, 1);
  assert.equal(weeks[0].albumTracks, 3);
  assert.deepEqual(weeks[0].frequentArtists, [
    { label: 'Album Artist (3)', album: 'Album lp' },
  ]);
});
