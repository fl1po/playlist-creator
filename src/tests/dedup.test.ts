import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlaylistItem } from '../lib/playlist-reads/index.js';
import {
  type DedupWrites,
  findDuplicates,
  removeDuplicates,
} from '../services/dedup.js';

/** A track slot; `id` doubles as the uri, so two slots of one id are one track. */
function slot(id: string, title: string, artist = 'Artist'): PlaylistItem {
  return {
    uri: `spotify:track:${id}`,
    addedAt: null,
    track: {
      id,
      name: title,
      durationMs: 1000,
      artists: [{ id: null, name: artist }],
      album: { id: '', name: '', releaseDate: '', artistNames: [] },
    },
  };
}

const local: PlaylistItem = {
  track: null,
  uri: 'spotify:local:a:b:c:1',
  addedAt: null,
};

/** A playlist with Spotify's write semantics: removing a uri takes every copy. */
function fakePlaylist(items: PlaylistItem[]) {
  const uris = items.map((i) => i.uri);
  const calls: string[] = [];
  const writes: DedupWrites = {
    async removeAll(uri) {
      calls.push(`remove ${uri}`);
      for (let i = uris.length - 1; i >= 0; i--)
        if (uris[i] === uri) uris.splice(i, 1);
    },
    async insert(uri, position) {
      calls.push(`insert ${uri} @${position}`);
      uris.splice(position, 0, uri);
    },
  };
  return { uris, calls, writes };
}

async function dedup(items: PlaylistItem[]) {
  const playlist = fakePlaylist(items);
  const removed = await removeDuplicates(
    items,
    findDuplicates(items),
    playlist.writes,
  );
  return { removed, ...playlist };
}

test('a track added twice keeps its first copy, where it was', async () => {
  const { removed, uris } = await dedup([
    slot('a', 'Intro'),
    slot('x', 'Song'),
    slot('b', 'Outro'),
    slot('x', 'Song'),
  ]);

  assert.equal(removed, 1);
  assert.deepEqual(uris, [
    'spotify:track:a',
    'spotify:track:x',
    'spotify:track:b',
  ]);
});

test('a different release of the same song goes without touching the kept one', async () => {
  const { removed, uris, calls } = await dedup([
    slot('single', 'Song'),
    slot('album', 'Song'),
  ]);

  assert.equal(removed, 1);
  assert.deepEqual(uris, ['spotify:track:single']);
  assert.deepEqual(calls, ['remove spotify:track:album']);
});

test('several groups, three copies and slots without a track keep their order', async () => {
  const { removed, uris } = await dedup([
    local,
    slot('x', 'Song'),
    slot('y', 'Other', 'Someone'),
    slot('x', 'Song'),
    slot('x2', 'Song'),
    slot('y', 'Other', 'Someone'),
    slot('z', 'Last'),
  ]);

  assert.equal(removed, 3);
  assert.deepEqual(uris, [
    'spotify:local:a:b:c:1',
    'spotify:track:x',
    'spotify:track:y',
    'spotify:track:z',
  ]);
});

test('the scan reports each later copy, and a playlist without any reports none', () => {
  const groups = findDuplicates([
    slot('x', 'Song'),
    slot('a', 'Intro'),
    slot('x', 'Song'),
  ]);

  assert.deepEqual(groups, [
    {
      artists: 'Artist',
      name: 'Song',
      keep: { uri: 'spotify:track:x', position: 0 },
      extra: [{ uri: 'spotify:track:x', position: 2 }],
    },
  ]);
  assert.deepEqual(findDuplicates([slot('a', 'A'), slot('b', 'B')]), []);
});
