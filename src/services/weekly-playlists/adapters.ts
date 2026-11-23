import { getAllUserPlaylists } from '../../lib/pagination.js';
import type { UserSession } from '../../lib/user-session.js';
import { spotifyPlaylistWrites } from '../promotion-sync/adapters.js';
import type { WeeklyPlaylistStore } from './index.js';

/**
 * Production WeeklyPlaylistStore over the session's gateway. Writes reuse
 * promotion sync's adapter (100-item chunks, uri formatting).
 */
export function spotifyWeeklyPlaylistStore(
  session: Pick<UserSession, 'gateway'>,
): WeeklyPlaylistStore {
  const ctx = session.gateway;
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
