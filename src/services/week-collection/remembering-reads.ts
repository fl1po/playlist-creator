import type { ReleaseReads } from './index.js';

/**
 * Thrown by a ReleaseReads adapter that couldn't complete a read. `degraded`
 * is what the caller gets instead (null, [], or the pages read before the
 * failure); `rememberingReads` hands it over without remembering it, so the
 * next call reads again.
 */
export class ReadFailed<T> extends Error {
  constructor(
    readonly degraded: T,
    message: string,
  ) {
    super(message);
    this.name = 'ReadFailed';
  }
}

/**
 * ReleaseReads that answer each read once per argument for their lifetime.
 * Build one per operation (a fill, a sync) and share it across its weeks:
 * none of these reads depends on which week is being collected.
 *
 * Only complete answers are remembered, "not found" included. A `ReadFailed`
 * answers with its degraded value; any other error (abort, auth loss, a
 * failed paged read) propagates. Neither is remembered. Concurrent reads of
 * one argument share a single call.
 */
export function rememberingReads(reads: ReleaseReads): ReleaseReads {
  const memo = new Map<string, Promise<unknown>>();

  function remember<T>(key: string, read: () => Promise<T>): Promise<T> {
    const hit = memo.get(key);
    if (hit) return hit as Promise<T>;
    const pending = read().catch((err: unknown) => {
      memo.delete(key);
      if (err instanceof ReadFailed) return err.degraded as T;
      throw err;
    });
    memo.set(key, pending);
    return pending;
  }

  return {
    searchArtist: (name) =>
      remember(`searchArtist\0${name}`, () => reads.searchArtist(name)),
    searchByUpc: (upc) =>
      remember(`searchByUpc\0${upc}`, () => reads.searchByUpc(upc)),
    artistAlbums: (id) =>
      remember(`artistAlbums\0${id}`, () => reads.artistAlbums(id)),
    albumDetails: (id) =>
      remember(`albumDetails\0${id}`, () => reads.albumDetails(id)),
    albumTracks: (id) =>
      remember(`albumTracks\0${id}`, () => reads.albumTracks(id)),
    playlistAlbums: (id) =>
      remember(`playlistAlbums\0${id}`, () => reads.playlistAlbums(id)),
    userPlaylists: (id) =>
      remember(`userPlaylists\0${id}`, () => reads.userPlaylists(id)),
    artistProfile: (id) =>
      remember(`artistProfile\0${id}`, () => reads.artistProfile(id)),
  };
}
