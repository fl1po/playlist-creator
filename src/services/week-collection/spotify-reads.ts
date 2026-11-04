import { getAlbumTracks, getPlaylistAlbums } from '../../lib/pagination.js';
import type { SpotifyGateway } from '../../lib/spotify/gateway.js';
import type { AlbumDetails, RawAlbum, ReleaseReads } from './index.js';
import { ReadFailed, rememberingReads } from './remembering-reads.js';

const PAGE = 50;
/** `artistAlbums` stops after the page at this offset: 3 pages, 150 releases. */
const MAX_OFFSET = 100;

/** The SDK album fields every album read keeps. */
function toRawAlbum(album: {
  id: string;
  name: string;
  album_type: string;
  release_date: string;
  available_markets?: string[];
}): RawAlbum {
  return {
    id: album.id,
    name: album.name,
    type: album.album_type,
    release_date: album.release_date,
    markets: album.available_markets?.length ?? 0,
  };
}

/**
 * Production ReleaseReads adapter: SpotifyGateway + the pagination readers,
 * remembered for the adapter's lifetime. Build one per operation (a fill, a
 * sync) and share it across its weeks. Auth failures and aborts throw; other
 * failures degrade (null / empty / the pages read so far) and are read again
 * on the next call.
 */
export function spotifyReleaseReads(ctx: SpotifyGateway): ReleaseReads {
  return rememberingReads(spotifyReads(ctx));
}

/**
 * The reads themselves. A failure throws `ReadFailed` with its degraded value
 * instead of returning it, so `rememberingReads` can tell it from a complete
 * answer. Never used unwrapped.
 */
function spotifyReads(ctx: SpotifyGateway): ReleaseReads {
  return {
    async searchArtist(name) {
      const result = await ctx.call(
        (api) => api.search(name, ['artist'], undefined, 5),
        `search "${name}"`,
      );
      if (!result.success) {
        throw new ReadFailed(null, `search "${name}" failed`);
      }
      if (result.data.artists?.items.length) {
        const exact = result.data.artists.items.find(
          (a: { name: string }) => a.name.toLowerCase() === name.toLowerCase(),
        );
        const match = exact ?? result.data.artists.items[0];
        return { id: match.id, name: match.name };
      }
      return null;
    },

    async searchByUpc(upc) {
      const result = await ctx.call(
        (api) => api.search(`upc:${upc}`, ['album']),
        `search upc ${upc}`,
      );
      if (!result.success) {
        throw new ReadFailed(null, `search upc ${upc} failed`);
      }
      const album = result.data.albums?.items[0];
      if (!album) {
        return null;
      }
      return {
        ...toRawAlbum(album),
        artists: album.artists.map((a) => ({ id: a.id, name: a.name })),
      };
    },

    async artistAlbums(artistId) {
      const albums: RawAlbum[] = [];
      let offset = 0;
      while (true) {
        const result = await ctx.call(
          (api) =>
            api.artists.albums(
              artistId,
              'album,single,compilation',
              undefined,
              PAGE,
              offset,
            ),
          `releases for ${artistId}`,
        );
        if (!result.success) {
          throw new ReadFailed(albums, `releases for ${artistId} failed`);
        }
        for (const album of result.data.items) {
          albums.push(toRawAlbum(album));
        }
        if (result.data.items.length < PAGE) break;
        offset += PAGE;
        if (offset > MAX_OFFSET) break;
      }
      return albums;
    },

    async albumDetails(albumId) {
      const result = await ctx.call(
        (api) => api.albums.get(albumId),
        `album details ${albumId}`,
      );
      if (!result.success) {
        throw new ReadFailed(null, `album details ${albumId} failed`);
      }
      const album = result.data;
      const details: AlbumDetails = {
        id: album.id,
        name: album.name,
        type: album.album_type,
        release_date: album.release_date,
        explicit: album.tracks.items.some(
          (track: { explicit: boolean }) => track.explicit,
        ),
        markets: album.available_markets?.length ?? 0,
        artists: album.artists.map((a) => ({ id: a.id, name: a.name })),
      };
      return details;
    },

    albumTracks(albumId) {
      return getAlbumTracks(ctx, albumId);
    },

    playlistAlbums(playlistId) {
      return getPlaylistAlbums(ctx, playlistId);
    },

    // First page only: external playlist sources are matched against the
    // user's first 50 playlists.
    async userPlaylists(userId) {
      const result = await ctx.call(
        (api) => api.playlists.getUsersPlaylists(userId, PAGE, 0),
        `playlists of ${userId}`,
      );
      if (!result.success) {
        throw new ReadFailed([], `playlists of ${userId} failed`);
      }
      return result.data.items.map((p: { id: string; name: string }) => ({
        id: p.id,
        name: p.name,
      }));
    },

    async artistProfile(artistId) {
      const result = await ctx.call(
        (api) => api.artists.get(artistId),
        `artist ${artistId}`,
      );
      if (!result.success) {
        throw new ReadFailed(null, `artist ${artistId} failed`);
      }
      return {
        popularity: result.data.popularity,
        followers: result.data.followers?.total ?? 0,
        genres: result.data.genres,
      };
    },
  };
}
