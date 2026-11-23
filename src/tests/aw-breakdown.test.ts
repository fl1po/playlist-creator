import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  awBreakdown,
  describeAwBreakdown,
  groupTracksByWeek,
} from '../domain/aw-breakdown.js';
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

test('the breakdown line counts the tracks and averages them per week', () => {
  const items = [
    item('a', { releaseDate: '2026-01-02' }),
    item('b', { releaseDate: '2026-01-09' }),
  ];
  assert.equal(
    describeAwBreakdown(awBreakdown(items), { cached: false, missing: 0 }),
    'AW breakdown: 2 weeks, 2 tracks, 2m · avg 1 tracks/1m per week',
  );
  assert.equal(
    describeAwBreakdown(awBreakdown(items), { cached: true, missing: 0 }),
    'AW breakdown: 2 weeks, 2 tracks, 2m · avg 1 tracks/1m per week (cached)',
  );
});

test('the breakdown line names the slots it could not count', () => {
  const empty: PlaylistItem = { track: null, uri: null, addedAt: null };
  const items = [item('a', { releaseDate: '2026-01-02' }), empty, empty];
  assert.equal(
    describeAwBreakdown(awBreakdown(items), { cached: false, missing: 0 }),
    'AW breakdown: 1 weeks, 1 tracks, 1m · avg 1 tracks/1m per week · 2 of 3 slots have no track data',
  );
});

test('the breakdown line names the tracks Spotify left out', () => {
  const items = [item('a', { releaseDate: '2026-01-02' })];
  assert.equal(
    describeAwBreakdown(awBreakdown(items), { cached: false, missing: 9 }),
    'AW breakdown: 1 weeks, 1 tracks, 1m · avg 1 tracks/1m per week · Spotify left out 9 of 10 tracks',
  );
});

test('the breakdown carries its age and its averages, worked out once', () => {
  const now = new Date('2026-01-10T12:00:00Z');
  const empty: PlaylistItem = { track: null, uri: null, addedAt: null };
  const b = awBreakdown(
    [
      item('a', { releaseDate: '2026-01-02' }),
      item('b', { releaseDate: '2026-01-02' }),
      item('c', { releaseDate: '2026-01-09' }),
      empty,
    ],
    now,
  );

  assert.equal(b.computedAt, now.toISOString());
  assert.deepEqual(
    [b.weekCount, b.totalTracks, b.totalDurationMs],
    [2, 3, 180_000],
  );
  assert.equal(b.averageTracks, 2);
  assert.equal(b.averageDurationMs, 90_000);
  assert.deepEqual([b.slots, b.emptySlots], [4, 1]);
});

test('an empty All Weekly averages to nothing rather than dividing by zero', () => {
  const b = awBreakdown([]);
  assert.deepEqual(
    [b.weekCount, b.averageTracks, b.averageDurationMs],
    [0, 0, 0],
  );
});
