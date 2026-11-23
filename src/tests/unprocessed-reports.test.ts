import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { fixtureGateway } from '../lib/spotify/fixture.js';
import { DEFAULT_USER_CONFIG } from '../lib/user-config.js';
import { LISTENING_TIME, localUserData } from '../lib/user-data/index.js';
import type { UserSession } from '../lib/user-session.js';
import { spotifyDedupWrites } from '../services/dedup.js';
import { unprocessedReports } from '../services/unprocessed-reports/index.js';

// ── Fixture ─────────────────────────────────────────────────────────────────

const USER = 'user-1';
const AW = 'aw';
const NOW = new Date('2025-09-30T12:00:00Z');

/** A track slot: `id` names the track, `minutes` its length. */
interface Slot {
  id: string;
  title?: string;
  artist?: string;
  minutes?: number;
  /** A local file: a slot with no track data. */
  local?: boolean;
}

interface Weekly {
  name: string;
  tracks: Slot[];
  /** Set while the user hasn't marked the playlist ready. */
  description?: string;
}

/**
 * A user whose playlists are `weeklies` (ids `pl-0`, `pl-1`, … in order) and
 * All Weekly holding `allWeekly`, served by a fake Spotify whose snapshot ids
 * change on every edit. `itemReads` lists each playlist whose items were
 * fetched; `failReadOf` makes one playlist's item fetch fail. Removing a uri
 * takes every copy of it, as Spotify does; `written` lists each playlist a
 * write touched, and `edit` stands in for a change made outside the app.
 */
function world(
  t: TestContext,
  weeklies: Weekly[],
  allWeekly: string[],
  opts: { signal?: AbortSignal } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unprocessed-reports-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = localUserData(dir);

  const listed = weeklies.map((w, i) => ({
    id: `pl-${i}`,
    name: w.name,
    description: w.description ?? '',
  }));
  const contents = new Map<string, Slot[]>([
    [AW, allWeekly.map((id) => ({ id }))],
    ...weeklies.map((w, i) => [`pl-${i}`, w.tracks] as [string, Slot[]]),
  ]);
  const versions = new Map<string, number>();
  const snapshot = (id: string) => `${id}@${versions.get(id) ?? 0}`;
  const itemReads: string[] = [];
  const written: string[] = [];
  const state = { failReadOf: '' };
  const uriOf = (s: Slot) => `spotify:${s.local ? 'local' : 'track'}:${s.id}`;
  const slotByUri = new Map(
    [...contents.values()].flat().map((s) => [uriOf(s), s]),
  );
  const edit = (id: string, slots: Slot[]) => {
    contents.set(id, slots);
    versions.set(id, (versions.get(id) ?? 0) + 1);
  };

  const rawItem = (s: Slot) => ({
    added_at: '2025-09-01T00:00:00Z',
    track: {
      id: s.local ? null : s.id,
      uri: uriOf(s),
      name: s.title ?? s.id,
      type: 'track',
      is_local: !!s.local,
      duration_ms: (s.minutes ?? 3) * 60_000,
      artists: [{ id: null, name: s.artist ?? 'Artist' }],
      album: { id: '', name: '', release_date: '', artists: [] },
    },
  });

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
        if (id === state.failReadOf) throw new Error(`no items for ${id}`);
        if (offset === 0) itemReads.push(id);
        const slots = contents.get(id) ?? [];
        return {
          total: slots.length,
          items: slots.slice(offset, offset + limit).map(rawItem),
        };
      },
      async removeItemsFromPlaylist(
        id: string,
        body: { tracks: Array<{ uri: string }> },
      ) {
        written.push(id);
        const gone = new Set(body.tracks.map((t) => t.uri));
        edit(
          id,
          (contents.get(id) ?? []).filter((s) => !gone.has(uriOf(s))),
        );
      },
      async addItemsToPlaylist(id: string, uris: string[], position: number) {
        written.push(id);
        const slots = [...(contents.get(id) ?? [])];
        slots.splice(
          position,
          0,
          ...uris.map((u) => slotByUri.get(u) ?? { id: u }),
        );
        edit(id, slots);
      },
    },
  };

  const session: UserSession = {
    gateway: fixtureGateway(api, { signal: opts.signal }),
    userId: USER,
    data,
  };
  const reports = () => unprocessedReports(session, { now: () => NOW });

  return {
    session,
    reports,
    itemReads,
    written,
    state,
    api,
    edit,
    /** A playlist's track ids as they stand. */
    trackIds: (id: string) => (contents.get(id) ?? []).map((s) => s.id),
    async ready() {
      await data.config.save({
        ...DEFAULT_USER_CONFIG,
        sourcePlaylists: {
          ...DEFAULT_USER_CONFIG.sourcePlaylists,
          allWeeklyId: AW,
        },
      });
    },
  };
}

/** Three weekly playlists; All Weekly overlaps the first, so two are unprocessed. */
const THREE_WEEKS: Weekly[] = [
  { name: '05.09.25', tracks: [{ id: 'a1' }] },
  {
    name: '12.09.25',
    tracks: [
      { id: 'b1', minutes: 4 },
      { id: 'b2', minutes: 5 },
    ],
  },
  {
    name: '19.09.25',
    tracks: [
      { id: 'c1', minutes: 10 },
      { id: 'loc', local: true },
    ],
    description: 'Weekly new music releases',
  },
];

// ── Listening time ──────────────────────────────────────────────────────────

test('listening time measures each unprocessed weekly playlist, oldest first', async (t) => {
  const w = world(t, THREE_WEEKS, ['a1', 'x1']);
  await w.ready();

  const lt = await w.reports().listeningTime();

  assert.deepEqual(lt.perPlaylist, [
    { name: '12.09.25', durationMs: 9 * 60_000, trackCount: 2, ready: true },
    // The local file has no track data, so it adds no time and no track; the
    // description still set means the user hasn't marked it ready.
    { name: '19.09.25', durationMs: 10 * 60_000, trackCount: 1, ready: false },
  ]);
  assert.equal(lt.playlistCount, 2);
  assert.equal(lt.totalMs, 19 * 60_000);
  assert.equal(lt.totalTracks, 3);
  assert.equal(lt.averageMs, 9.5 * 60_000);
  assert.equal(lt.computedAt, NOW.toISOString());
});

test('listening time is kept as the last one, for the page to show with its age', async (t) => {
  const w = world(t, THREE_WEEKS, ['a1']);
  await w.ready();

  const lt = await w.reports().listeningTime();

  assert.deepEqual(await w.session.data.load(LISTENING_TIME), lt);
});

test('a listening time kept before it carried its average counts as none yet', async (t) => {
  const w = world(t, THREE_WEEKS, ['a1']);
  await w.session.data.save(LISTENING_TIME, {
    totalMs: 1,
    totalTracks: 1,
    playlistCount: 1,
  } as never);

  assert.equal(await w.session.data.load(LISTENING_TIME), null);
});

test('a second report reads no unchanged playlist again', async (t) => {
  const w = world(t, THREE_WEEKS, ['a1']);
  await w.ready();
  await w.reports().listeningTime();
  w.itemReads.length = 0;

  const lt = await w.reports().listeningTime();

  assert.equal(lt.cachedReads, 2);
  // Every snapshot is unchanged, All Weekly's included: no items fetched.
  assert.deepEqual(w.itemReads, []);
});

test('each playlist is reported as it is measured, with its own measurement', async (t) => {
  const w = world(t, THREE_WEEKS, ['a1']);
  await w.ready();
  const seen: string[] = [];

  await w.reports().listeningTime({
    onPlaylist: (done, total, pl, m) =>
      seen.push(`${done}/${total} ${pl.name} ${m.durationMs / 60_000}m`),
  });

  assert.deepEqual(seen, ['1/2 12.09.25 9m', '2/2 19.09.25 10m']);
});

test('no unprocessed weekly playlists measure to nothing', async (t) => {
  const w = world(t, THREE_WEEKS, ['c1']);
  await w.ready();

  const lt = await w.reports().listeningTime();

  assert.deepEqual(
    [lt.playlistCount, lt.totalMs, lt.averageMs, lt.perPlaylist],
    [0, 0, 0, []],
  );
});

test('a playlist that cannot be read fails the report, and nothing is kept', async (t) => {
  const w = world(t, THREE_WEEKS, ['a1']);
  await w.ready();
  w.state.failReadOf = 'pl-2';

  await assert.rejects(w.reports().listeningTime(), /no items for pl-2/);
  assert.equal(await w.session.data.load(LISTENING_TIME), null);
});

test('a stop ends the report before its next playlist, even a cached one', async (t) => {
  const stop = new AbortController();
  const w = world(t, THREE_WEEKS, ['a1'], { signal: stop.signal });
  await w.ready();

  await assert.rejects(
    w.reports().listeningTime({
      onPlaylist: (done) => {
        if (done === 1) stop.abort(new Error('stopped'));
      },
    }),
    /stopped/,
  );
});

// ── Duplicates ──────────────────────────────────────────────────────────────

test('duplicates are reported per unprocessed weekly playlist, by the removal rule', async (t) => {
  const w = world(
    t,
    [
      { name: '05.09.25', tracks: [{ id: 'a1' }, { id: 'a1' }] },
      {
        name: '12.09.25',
        tracks: [
          { id: 'b1', title: 'Song', artist: 'X' },
          { id: 'b2' },
          { id: 'b3', title: 'Song', artist: 'X' },
          { id: 'b1', title: 'Song', artist: 'X' },
        ],
      },
      { name: '19.09.25', tracks: [{ id: 'c1' }, { id: 'c2' }] },
    ],
    ['a1'],
  );
  await w.ready();

  const d = await w.reports().duplicates();

  // 05.09.25 is past the cutoff, so its duplicate isn't reported.
  assert.equal(d.scanned, 2);
  assert.equal(d.totalDuplicates, 2);
  assert.deepEqual(
    d.playlists.map((p) => [p.id, p.name, p.duplicateCount]),
    [['pl-1', '12.09.25', 2]],
  );
  assert.deepEqual(
    d.playlists[0].groups.map((g) => [g.artists, g.name, g.keep.position]),
    [['X', 'Song', 0]],
  );
});

test('every scanned playlist is reported as it is scanned, with or without duplicates', async (t) => {
  const w = world(
    t,
    [
      { name: '05.09.25', tracks: [{ id: 'a1' }] },
      { name: '12.09.25', tracks: [{ id: 'b1' }, { id: 'b1' }] },
      { name: '19.09.25', tracks: [{ id: 'c1' }] },
    ],
    ['a1'],
  );
  await w.ready();
  const seen: string[] = [];

  await w.reports().duplicates({
    onPlaylist: (_d, _t, pl, m) => seen.push(`${pl.name}:${m.duplicateCount}`),
  });

  assert.deepEqual(seen, ['12.09.25:1', '19.09.25:0']);
});

// ── Removing duplicates ─────────────────────────────────────────────────────

/** 05.09.25 is past the cutoff; 12.09.25 and 19.09.25 both hold duplicates. */
const DUPLICATED: Weekly[] = [
  { name: '05.09.25', tracks: [{ id: 'a1' }, { id: 'a2' }, { id: 'a2' }] },
  {
    name: '12.09.25',
    tracks: [
      { id: 'b1', title: 'Song', artist: 'X' },
      { id: 'b2' },
      { id: 'b3', title: 'Song', artist: 'X' },
      { id: 'b1', title: 'Song', artist: 'X' },
    ],
  },
  { name: '19.09.25', tracks: [{ id: 'c1' }, { id: 'c1' }, { id: 'c2' }] },
];

test('removal takes out exactly what the scan reported, keeping each first copy', async (t) => {
  const w = world(t, DUPLICATED, ['a1']);
  await w.ready();
  const scan = await w.reports().duplicates();

  const result = await w
    .reports()
    .removeDuplicates(scan.playlists.map((p) => p.id));

  assert.equal(result.totalRemoved, scan.totalDuplicates);
  assert.deepEqual(result.perPlaylist, [
    { id: 'pl-1', name: '12.09.25', removed: 2 },
    { id: 'pl-2', name: '19.09.25', removed: 1 },
  ]);
  assert.deepEqual(result.refused, []);
  assert.deepEqual(w.trackIds('pl-1'), ['b1', 'b2']);
  assert.deepEqual(w.trackIds('pl-2'), ['c1', 'c2']);
  assert.equal((await w.reports().duplicates()).totalDuplicates, 0);
});

test('only the playlists asked for are touched', async (t) => {
  const w = world(t, DUPLICATED, ['a1']);
  await w.ready();

  const result = await w.reports().removeDuplicates(['pl-2']);

  assert.equal(result.totalRemoved, 1);
  assert.deepEqual([...new Set(w.written)], ['pl-2']);
});

test('a playlist that is not an unprocessed weekly playlist is refused and left alone', async (t) => {
  const w = world(t, DUPLICATED, ['a1', 'x1', 'x1']);
  await w.ready();

  // All Weekly, a weekly playlist past the cutoff, and an unknown id.
  const result = await w
    .reports()
    .removeDuplicates([AW, 'pl-0', 'pl-zz', 'pl-1']);

  assert.deepEqual(result.refused, [AW, 'pl-0', 'pl-zz']);
  assert.deepEqual(
    result.perPlaylist.map((p) => p.id),
    ['pl-1'],
  );
  assert.deepEqual([...new Set(w.written)], ['pl-1']);
  assert.deepEqual(w.trackIds(AW), ['a1', 'x1', 'x1']);
  assert.deepEqual(w.trackIds('pl-0'), ['a1', 'a2', 'a2']);
});

test('a playlist listened to since the scan is refused', async (t) => {
  const w = world(t, DUPLICATED, ['a1']);
  await w.ready();
  const scan = await w.reports().duplicates();

  // The user listens through 12.09.25: it's past the cutoff now.
  w.edit(AW, [{ id: 'a1' }, { id: 'b2' }]);
  const result = await w
    .reports()
    .removeDuplicates(scan.playlists.map((p) => p.id));

  assert.deepEqual(result.refused, ['pl-1']);
  assert.deepEqual(w.trackIds('pl-1'), ['b1', 'b2', 'b3', 'b1']);
  assert.deepEqual(w.trackIds('pl-2'), ['c1', 'c2']);
});

test('each playlist is reported as its duplicates are removed', async (t) => {
  const w = world(t, DUPLICATED, ['a1']);
  await w.ready();
  const seen: string[] = [];

  await w.reports().removeDuplicates(['pl-1', 'pl-2'], {
    onPlaylist: (done, total, pl, removed) =>
      seen.push(`${done}/${total} ${pl.name}:${removed}`),
  });

  assert.deepEqual(seen, ['1/2 12.09.25:2', '2/2 19.09.25:1']);
});

test('a stop ends the removal before its next playlist', async (t) => {
  const stop = new AbortController();
  const w = world(t, DUPLICATED, ['a1'], { signal: stop.signal });
  await w.ready();

  await assert.rejects(
    w.reports().removeDuplicates(['pl-1', 'pl-2'], {
      onPlaylist: (done) => {
        if (done === 1) stop.abort(new Error('stopped'));
      },
    }),
    /stopped/,
  );
  assert.deepEqual(w.trackIds('pl-2'), ['c1', 'c1', 'c2']);
});

// ── Dedup writes over Spotify ───────────────────────────────────────────────

test('dedup writes remove by uri and put a kept copy back at its position', async (t) => {
  const w = world(t, [], []);
  const calls: unknown[] = [];
  Object.assign(w.api.playlists, {
    async removeItemsFromPlaylist(id: string, body: unknown) {
      calls.push(['remove', id, body]);
    },
    async addItemsToPlaylist(id: string, uris: string[], position: number) {
      calls.push(['insert', id, uris, position]);
    },
  });
  const writes = spotifyDedupWrites(w.session.gateway, 'pl-9');

  await writes.removeAll('spotify:track:t1');
  await writes.insert('spotify:track:t1', 3);

  assert.deepEqual(calls, [
    ['remove', 'pl-9', { tracks: [{ uri: 'spotify:track:t1' }] }],
    ['insert', 'pl-9', ['spotify:track:t1'], 3],
  ]);
});

test('a dedup write Spotify refuses throws, so removal stops there', async (t) => {
  const w = world(t, [], []);
  Object.assign(w.api.playlists, {
    async removeItemsFromPlaylist() {
      throw new Error('forbidden');
    },
  });

  await assert.rejects(
    spotifyDedupWrites(w.session.gateway, 'pl-9').removeAll('spotify:track:t1'),
    /forbidden/,
  );
});
