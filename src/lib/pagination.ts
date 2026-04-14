import fs from 'node:fs';
import path from 'node:path';
import { parseDate } from '../domain/tracks.js';
import type { SpotifyContext } from './spotify-context.js';
import { trackKey } from './track-utils.js';
import type {
  AlbumTrack,
  FoundRelease,
  PlaylistAlbumInfo,
  SimplePlaylist,
} from './types.js';

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

const NON_LISTENED_CACHE = 'non-listened-cache.json';

interface NonListenedCache {
  playlists: SimplePlaylist[];
}

export const LISTENING_TIME_CACHE = 'listening-time-cache.json';

/** Invalidate the non-listened playlists and listening time caches. */
export function invalidateNonListenedCache(dataDir: string): void {
  for (const file of [NON_LISTENED_CACHE, LISTENING_TIME_CACHE]) {
    try {
      fs.unlinkSync(path.join(dataDir, file));
    } catch {
      /* missing file is fine */
    }
  }
}

/**
 * Get non-listened weekly playlists.
 *
 * Returns cached result when available. Otherwise iterates weekly playlists
 * from newest to oldest, stopping at the first with AW overlap. Result is
 * cached to disk so subsequent calls are instant.
 */
export async function getNonListenedPlaylists(
  ctx: SpotifyContext,
  userId: string,
  allWeeklyId: string,
  dataDir: string,
  log?: (message: string) => void,
): Promise<{ playlists: SimplePlaylist[]; awTrackIds: Set<string> }> {
  const emit = log ?? (() => {});
  const cachePath = path.join(dataDir, NON_LISTENED_CACHE);

  const awTrackIds = new Set(await getAllPlaylistTracks(ctx, allWeeklyId));
  emit(`Loaded ${awTrackIds.size} tracks from All Weekly`);

  // Try cache
  try {
    const cached: NonListenedCache = JSON.parse(
      fs.readFileSync(cachePath, 'utf8'),
    );
    if (cached.playlists != null) {
      emit(
        `Using cached non-listened playlists (${cached.playlists.length})`,
      );
      return { playlists: cached.playlists, awTrackIds };
    }
  } catch {
    /* cache miss */
  }

  // Scan from newest to oldest
  const allPlaylists = await getAllUserPlaylists(ctx, userId);
  emit(`Found ${allPlaylists.length} user playlists`);

  const weeklyPattern = /^(\d{2})\.(\d{2})\.(\d{2})$/;
  const weeklies = allPlaylists
    .filter((pl) => pl.trackCount > 0 && weeklyPattern.test(pl.name))
    .sort(
      (a, b) => parseDate(b.name).getTime() - parseDate(a.name).getTime(),
    ); // newest first

  emit(`Found ${weeklies.length} weekly playlists, scanning from newest...`);

  const nonListened: SimplePlaylist[] = [];

  for (let i = 0; i < weeklies.length; i++) {
    const pl = weeklies[i];
    const trackIds = await getAllPlaylistTracks(ctx, pl.id);
    const hasOverlap = trackIds.some((id) => awTrackIds.has(id));

    if (hasOverlap) {
      emit(`  ${pl.name} — AW overlap found, cutoff reached`);
      break;
    }

    emit(`  ${pl.name} — non-listened (${i + 1})`);
    nonListened.push(pl);
  }

  // Reverse so result is chronological (oldest first)
  nonListened.reverse();

  emit(`Result: ${nonListened.length} non-listened playlists`);

  // Write cache
  const cache: NonListenedCache = { playlists: nonListened };
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));

  return { playlists: nonListened, awTrackIds };
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
  albumId: string;
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
        const t = item.track as unknown as {
          artists?: Array<{ name: string }>;
          album?: { id: string };
        };
        tracks.push({
          uri: item.track.uri,
          id: item.track.id,
          name: item.track.name,
          artistNames: (t.artists ?? []).map((a) => a.name),
          albumId: t.album?.id ?? '',
        });
      }
    }
    if (result.data.items.length < limit) break;
    offset += limit;
  }

  return tracks;
}

/** Get total duration of all tracks in a playlist. */
export async function getPlaylistTotalDuration(
  ctx: SpotifyContext,
  playlistId: string,
): Promise<{ totalMs: number; trackCount: number }> {
  let totalMs = 0;
  let trackCount = 0;
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
      `playlist duration ${playlistId}`,
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      return { totalMs, trackCount };
    }

    for (const item of result.data.items) {
      if (item.track) {
        totalMs +=
          (item.track as unknown as { duration_ms?: number }).duration_ms ?? 0;
        trackCount++;
      }
    }
    if (result.data.items.length < limit) break;
    offset += limit;
  }

  return { totalMs, trackCount };
}

/** Fetch album popularity in batches of 20. */
export async function fetchReleasePopularities(
  ctx: SpotifyContext,
  releases: Map<string, FoundRelease>,
): Promise<Map<string, number>> {
  const popularities = new Map<string, number>();
  const ids = [...releases.keys()];

  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    const result = await ctx.call(
      () => ctx.api.albums.get(batch),
      'album popularity batch',
    );
    if (result.success) {
      for (const album of result.data) {
        popularities.set(album.id, album.popularity);
      }
    }
  }

  return popularities;
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
