import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { AI_PICKS } from '../lib/cache-files.js';
import { createDurableCache } from '../lib/durable-cache.js';
import { fixtureGateway } from '../lib/spotify/fixture.js';
import { listAiPicks, readWeekPicks } from '../services/ai-picks.js';

// ── Fixture: a user's playlists on a fake Spotify, counting calls ──────────

const USER = 'user-1';

function fakeSpotify(playlists: Array<{ name: string; albumIds: string[] }>) {
  const calls: string[] = [];
  const api = {
    playlists: {
      getUsersPlaylists: async (_user: string, limit: number, offset: number) => {
        calls.push('list');
        return {
          items: playlists.slice(offset, offset + limit).map((p, i) => ({
            id: `pl-${offset + i}`,
            name: p.name,
            owner: { id: USER },
            tracks: { total: p.albumIds.length },
          })),
          total: playlists.length,
        };
      },
      getPlaylistItems: async (
        id: string,
        _m: unknown,
        _f: unknown,
        limit: number,
        offset: number,
      ) => {
        calls.push(`items ${id}`);
        const albums = playlists[Number(id.slice(3))].albumIds;
        return {
          items: albums.slice(offset, offset + limit).map((albumId, i) => ({
            track: {
              id: `t-${offset + i}`,
              uri: `spotify:track:t-${offset + i}`,
              name: 'Track',
              artists: [],
              album: { id: albumId },
            },
          })),
          total: albums.length,
        };
      },
    },
  };
  return { gateway: fixtureGateway(api), calls };
}

function tempCache(t: TestContext) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-picks-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return createDurableCache({ userId: USER, dataDir, redis: null });
}

const pick = (albumId: string, confidence: number) => ({
  albumId,
  artist: `Artist ${albumId}`,
  title: `Title ${albumId}`,
  confidence,
  reason: `Because ${albumId}`,
});

const WEEK = {
  picks: [pick('a', 60), pick('b', 90), pick('c', 75)],
};

// ── Listing the records ─────────────────────────────────────────────────────

test('no records: an empty list', async (t) => {
  assert.deepEqual(await listAiPicks(tempCache(t)), []);
});

test('weeks list newest first, by date rather than by name', async (t) => {
  const cache = tempCache(t);
  await cache.save(AI_PICKS, {
    '30.05.25': { picks: [] },
    '06.03.26': { skipped: 'over-budget' },
    '02.01.26': WEEK,
  });

  const weeks = await listAiPicks(cache);

  assert.deepEqual(
    weeks.map((w) => w.date),
    ['06.03.26', '02.01.26', '30.05.25'],
  );
  assert.deepEqual(weeks[0].record, { skipped: 'over-budget' });
});

// ── Reading a week live ─────────────────────────────────────────────────────

test('present picks list highest confidence first; removed ones only count', async () => {
  const { gateway } = fakeSpotify([
    { name: '01.01.26', albumIds: ['x'] },
    { name: '02.01.26', albumIds: ['r', 'a', 'b', 'b'] },
  ]);

  const week = await readWeekPicks(gateway, USER, '02.01.26', WEEK.picks);

  assert.deepEqual(week, {
    exists: true,
    total: 3,
    present: [pick('b', 90), pick('a', 60)],
  });
});

test('a partly pruned album still counts as present', async () => {
  // Album "b" had several tracks; one is left.
  const { gateway } = fakeSpotify([{ name: '02.01.26', albumIds: ['b'] }]);

  const week = await readWeekPicks(gateway, USER, '02.01.26', WEEK.picks);

  assert.deepEqual(week, { exists: true, total: 3, present: [pick('b', 90)] });
});

test('a fully pruned week keeps its pick count, unlike a zero-pick week', async () => {
  const { gateway } = fakeSpotify([{ name: '02.01.26', albumIds: ['r'] }]);

  const pruned = await readWeekPicks(gateway, USER, '02.01.26', WEEK.picks);
  const empty = await readWeekPicks(gateway, USER, '02.01.26', []);

  assert.deepEqual(pruned, { exists: true, total: 3, present: [] });
  assert.deepEqual(empty, { exists: true, total: 0, present: [] });
});

test('a deleted weekly playlist reads as gone, without reading tracks', async () => {
  const { gateway, calls } = fakeSpotify([
    { name: '09.01.26', albumIds: ['a'] },
  ]);

  const week = await readWeekPicks(gateway, USER, '02.01.26', WEEK.picks);

  assert.deepEqual(week, { exists: false });
  assert.deepEqual(calls, ['list']);
});

