import { getAllUserPlaylists } from '../../lib/pagination.js';
import type { SpotifyGateway } from '../../lib/spotify/gateway.js';
import type { SimplePlaylist } from '../../lib/types.js';
import { spotifyPlaylistWrites } from '../promotion-sync/adapters.js';
import type { WeeklyPlaylistStore } from './index.js';

/**
 * Production WeeklyPlaylistStore over SpotifyGateway + pagination. Track
 * writes reuse promotion sync's adapter (100-item chunks, uri formatting).
 */
export function spotifyWeeklyPlaylistStore(
  ctx: SpotifyGateway,
): WeeklyPlaylistStore {
  const writes = spotifyPlaylistWrites(ctx);
  return {
    list(userId, onProgress) {
      return getAllUserPlaylists(ctx, userId, { onProgress });
    },
    async create(userId, name) {
      const result = await ctx.call(
        (api) =>
          api.playlists.createPlaylist(userId, {
            name,
            description: 'Weekly new music releases',
            public: false,
          }),
        `create playlist ${name}`,
      );
      if (!result.success) {
        throw new Error(`Failed to create playlist for ${name}`);
      }
      return { id: result.data.id, url: result.data.external_urls.spotify };
    },
    addTracks: writes.addTracks,
  };
}

/**
 * In-memory WeeklyPlaylistStore for tests: a listing plus a record of every
 * create and add. `calls` receives the same log, so a test can check ordering
 * against other ports that share it.
 */
export function memoryWeeklyPlaylistStore(
  initial: SimplePlaylist[],
  calls: string[] = [],
): WeeklyPlaylistStore & {
  created: SimplePlaylist[];
  added: Map<string, string[]>;
  failAddWith?: Error;
} {
  const playlists = initial.map((p) => ({ ...p }));
  const created: SimplePlaylist[] = [];
  const added = new Map<string, string[]>();
  return {
    created,
    added,
    async list(_userId, onProgress) {
      onProgress?.(playlists.length, playlists.length);
      return playlists.map((p) => ({ ...p }));
    },
    async create(_userId, name) {
      const playlist = { id: `pl-${created.length + 1}`, name, trackCount: 0 };
      playlists.push(playlist);
      created.push(playlist);
      calls.push(`create ${name}`);
      return {
        id: playlist.id,
        url: `https://open.spotify.com/playlist/${playlist.id}`,
      };
    },
    async addTracks(playlistId, trackIds) {
      calls.push(`add ${playlistId}`);
      if (this.failAddWith) throw this.failAddWith;
      added.set(playlistId, [...(added.get(playlistId) ?? []), ...trackIds]);
      const playlist = playlists.find((p) => p.id === playlistId);
      if (playlist) playlist.trackCount += trackIds.length;
    },
  };
}
