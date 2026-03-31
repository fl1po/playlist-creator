import type { SpotifyContext } from './spotify-context.js';
import { trackKey } from './track-utils.js';
import type { AlbumTrack, PlaylistAlbumInfo, SimplePlaylist } from './types.js';

/** Get all track IDs from a playlist. */
export async function getAllPlaylistTracks(
  ctx: SpotifyContext,
  playlistId: string,
): Promise<string[]> {
  const tracks: string[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const result = await ctx.call(
      () =>
        ctx.api.playlists.getPlaylistItems(
          playlistId,
          undefined,
          undefined,
          limit,
          offset,
        ),
      `playlist tracks ${playlistId}`,
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      return tracks;
    }

    for (const item of result.data.items) {
      if (item.track?.id) {
        tracks.push(item.track.id);
      }
    }
    if (result.data.items.length < limit) break;
    offset += limit;
  }

  return tracks;
}

/** Get all playlists owned by a user. */
export async function getAllUserPlaylists(
  ctx: SpotifyContext,
  userId: string,
): Promise<SimplePlaylist[]> {
  const playlists: SimplePlaylist[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const result = await ctx.call(
      () => ctx.api.playlists.getUsersPlaylists(userId, limit, offset),
      'user playlists',
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      return playlists;
    }

    for (const playlist of result.data.items) {
      if (playlist.owner.id === userId) {
        playlists.push({
          id: playlist.id,
          name: playlist.name,
          trackCount: playlist.tracks.total,
        });
      }
    }
    if (result.data.items.length < limit) break;
    offset += limit;
  }

  return playlists;
}

/** Get all tracks from an album with normalized dedup keys. */
export async function getAlbumTracks(
  ctx: SpotifyContext,
  albumId: string,
): Promise<AlbumTrack[]> {
  const tracks: AlbumTrack[] = [];
  let offset = 0;

  while (true) {
    const result = await ctx.call(
      () => ctx.api.albums.tracks(albumId, undefined, 50, offset),
      `tracks for album ${albumId}`,
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      return tracks;
    }

    for (const track of result.data.items) {
      const artistNames = track.artists.map((a: { name: string }) => a.name);
      const key = trackKey(artistNames, track.name);
      tracks.push({
        id: track.id,
        name: track.name,
        key,
        explicit: (track as unknown as { explicit?: boolean }).explicit,
      });
    }

    if (result.data.items.length < 50) break;
    offset += 50;
  }

  return tracks;
}

/** Get unique albums referenced by tracks in a playlist. */
export async function getPlaylistAlbums(
  ctx: SpotifyContext,
  playlistId: string,
  maxOffset = 200,
): Promise<Map<string, PlaylistAlbumInfo>> {
  const albums = new Map<string, PlaylistAlbumInfo>();
  let offset = 0;

  while (true) {
    const result = await ctx.call(
      () =>
        ctx.api.playlists.getPlaylistItems(
          playlistId,
          undefined,
          undefined,
          50,
          offset,
        ),
      `editorial playlist ${playlistId}`,
    );
    if (!result.success) {
      if (result.authError) throw result.error;
      break;
    }

    for (const item of result.data.items) {
      if (item.track?.album) {
        const albumId = item.track.album.id;
        if (!albums.has(albumId)) {
          albums.set(albumId, {
            id: albumId,
            name: item.track.album.name,
            artistName:
              (item.track as unknown as { artists?: Array<{ name: string }> })
                .artists?.[0]?.name ?? 'Unknown',
          });
        }
      }
    }
    if (result.data.items.length < 50) break;
    offset += 50;
    if (offset > maxOffset) break;
  }

  return albums;
}

/** Get all tracks from a playlist with normalized dedup keys. */
export async function getPlaylistTracksDetailed(
  ctx: SpotifyContext,
  playlistId: string,
): Promise<Array<{ uri: string; name: string; key: string; artists: string }>> {
  const tracks: Array<{
    uri: string;
    name: string;
    key: string;
    artists: string;
  }> = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const result = await ctx.call(
      () =>
        ctx.api.playlists.getPlaylistItems(
          playlistId,
          undefined,
          undefined,
          limit,
          offset,
        ),
      `playlist tracks detailed ${playlistId}`,
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      return tracks;
    }

    for (const item of result.data.items) {
      if (item.track?.id) {
        const trackArtists =
          (item.track as unknown as { artists?: Array<{ name: string }> })
            .artists ?? [];
        const artistNames = trackArtists.map((a) => a.name);
        const key = trackKey(artistNames, item.track.name);
        const displayArtists = artistNames.join(', ');
        tracks.push({
          uri: item.track.uri,
          name: item.track.name,
          key,
          artists: displayArtists,
        });
      }
    }
    if (result.data.items.length < limit) break;
    offset += limit;
  }

  return tracks;
}

// ── Playlist tracks with individual artist names ────────────────────────────

export interface PlaylistTrackWithArtists {
  uri: string;
  id: string;
  name: string;
  artistNames: string[];
}

/** Get all tracks from a playlist with individual artist names (not comma-joined). */
export async function getPlaylistTracksWithArtists(
  ctx: SpotifyContext,
  playlistId: string,
): Promise<PlaylistTrackWithArtists[]> {
  const tracks: PlaylistTrackWithArtists[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const result = await ctx.call(
      () =>
        ctx.api.playlists.getPlaylistItems(
          playlistId,
          undefined,
          undefined,
          limit,
          offset,
        ),
      `playlist tracks with artists ${playlistId}`,
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      return tracks;
    }

    for (const item of result.data.items) {
      if (item.track?.id) {
        const trackArtists =
          (item.track as unknown as { artists?: Array<{ name: string }> })
            .artists ?? [];
        tracks.push({
          uri: item.track.uri,
          id: item.track.id,
          name: item.track.name,
          artistNames: trackArtists.map((a) => a.name),
        });
      }
    }
    if (result.data.items.length < limit) break;
    offset += limit;
  }

  return tracks;
}

/** Scan playlist tracks with position info for recency calculations. */
export async function getPlaylistTracksWithPositions(
  ctx: SpotifyContext,
  playlistId: string,
): Promise<{
  artistData: Map<
    string,
    { positions: number[]; trackCount: number; id: string | null }
  >;
  totalTracks: number;
}> {
  const artistData = new Map<
    string,
    { positions: number[]; trackCount: number; id: string | null }
  >();
  let offset = 0;
  const limit = 50;
  let position = 0;
  let totalTracks = 0;

  while (true) {
    const result = await ctx.call(
      () =>
        ctx.api.playlists.getPlaylistItems(
          playlistId,
          undefined,
          undefined,
          limit,
          offset,
        ),
      `playlist tracks with positions ${playlistId}`,
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      break;
    }

    if (offset === 0) {
      totalTracks = result.data.total;
    }

    for (const item of result.data.items) {
      if (item.track?.artists) {
        for (const artist of item.track.artists as Array<{
          id: string;
          name: string;
        }>) {
          const name = artist.name;
          if (!artistData.has(name)) {
            artistData.set(name, {
              positions: [],
              trackCount: 0,
              id: artist.id,
            });
          }
          const data = artistData.get(name);
          data?.positions.push(position);
          if (data) data.trackCount++;
        }
      }
      position++;
    }

    if (result.data.items.length < limit) break;
    offset += limit;
  }

  return { artistData, totalTracks };
}
