import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskAborted } from '../lib/spotify/gateway.js';
import type {
  RawAlbum,
  ReleaseReads,
} from '../services/week-collection/index.js';
import {
  ReadFailed,
  rememberingReads,
} from '../services/week-collection/remembering-reads.js';

const ALBUM: RawAlbum = {
  id: 'alb-1',
  name: 'Record',
  type: 'album',
  release_date: '2026-06-05',
  markets: 2,
};

/**
 * A ReleaseReads whose every read is recorded as `method:arg` and answered by
 * `answer`, which may throw to simulate a failure.
 */
function countingReads(
  answer: (method: string, arg: string) => unknown = () => null,
): ReleaseReads & { calls: string[] } {
  const calls: string[] = [];
  const read =
    (method: string) =>
    async (arg: string): Promise<never> => {
      calls.push(`${method}:${arg}`);
      return answer(method, arg) as never;
    };
  return {
    calls,
    searchArtist: read('searchArtist'),
    searchByUpc: read('searchByUpc'),
    artistAlbums: read('artistAlbums'),
    albumDetails: read('albumDetails'),
    albumTracks: read('albumTracks'),
    playlistAlbums: read('playlistAlbums'),
    userPlaylists: read('userPlaylists'),
    artistProfile: read('artistProfile'),
  };
}

test('every read is made once per argument, then answered from memory', async () => {
  const inner = countingReads((method) =>
    method === 'artistAlbums' ? [ALBUM] : null,
  );
  const reads = rememberingReads(inner);

  for (let week = 0; week < 3; week++) {
    await reads.searchArtist('Kilo');
    await reads.searchByUpc('0602');
    await reads.artistAlbums('art-1');
    await reads.albumDetails('alb-1');
    await reads.albumTracks('alb-1');
    await reads.playlistAlbums('pl-1');
    await reads.userPlaylists('user-1');
    await reads.artistProfile('art-1');
  }
  await reads.artistAlbums('art-2');

  assert.deepEqual(inner.calls, [
    'searchArtist:Kilo',
    'searchByUpc:0602',
    'artistAlbums:art-1',
    'albumDetails:alb-1',
    'albumTracks:alb-1',
    'playlistAlbums:pl-1',
    'userPlaylists:user-1',
    'artistProfile:art-1',
    'artistAlbums:art-2',
  ]);
  assert.deepEqual(await reads.artistAlbums('art-1'), [ALBUM]);
});

test('a not-found answer is remembered: an unknown name is searched once', async () => {
  const inner = countingReads(() => null);
  const reads = rememberingReads(inner);

  assert.equal(await reads.searchArtist('Nobody'), null);
  assert.equal(await reads.searchArtist('Nobody'), null);

  assert.deepEqual(inner.calls, ['searchArtist:Nobody']);
});

test('a failed read answers with its degraded value and is read again next time', async () => {
  let failing = true;
  const inner = countingReads(() => {
    if (failing) throw new ReadFailed([ALBUM], 'page 2 failed');
    return [ALBUM, { ...ALBUM, id: 'alb-2' }];
  });
  const reads = rememberingReads(inner);

  const partial = await reads.artistAlbums('art-1');
  failing = false;
  const full = await reads.artistAlbums('art-1');
  const again = await reads.artistAlbums('art-1');

  assert.deepEqual(
    partial.map((a) => a.id),
    ['alb-1'],
  );
  assert.deepEqual(
    full.map((a) => a.id),
    ['alb-1', 'alb-2'],
  );
  assert.deepEqual(again, full);
  assert.deepEqual(inner.calls, ['artistAlbums:art-1', 'artistAlbums:art-1']);
});

test('any other error propagates and is not remembered', async () => {
  let thrown: Error | null = new Error('pagination failed');
  const inner = countingReads(() => {
    if (thrown) throw thrown;
    return [];
  });
  const reads = rememberingReads(inner);

  await assert.rejects(reads.albumTracks('alb-1'), /pagination failed/);
  thrown = new TaskAborted();
  await assert.rejects(reads.albumTracks('alb-1'), TaskAborted);
  thrown = null;
  assert.deepEqual(await reads.albumTracks('alb-1'), []);

  assert.equal(inner.calls.length, 3);
});

test('two concurrent reads of the same argument make one call', async () => {
  const inner = countingReads(() => [ALBUM]);
  const reads = rememberingReads(inner);

  const [a, b] = await Promise.all([
    reads.artistAlbums('art-1'),
    reads.artistAlbums('art-1'),
  ]);

  assert.deepEqual(a, b);
  assert.deepEqual(inner.calls, ['artistAlbums:art-1']);
});

test('different reads with the same argument are remembered apart', async () => {
  const inner = countingReads((method) =>
    method === 'artistAlbums' ? [ALBUM] : { popularity: 50 },
  );
  const reads = rememberingReads(inner);

  assert.deepEqual(await reads.artistAlbums('art-1'), [ALBUM]);
  assert.deepEqual(await reads.artistProfile('art-1'), { popularity: 50 });
});
