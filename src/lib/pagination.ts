import fs from 'node:fs';
import path from 'node:path';
import { formatDdMmYy, parseDate, toReleaseFriday } from '../domain/tracks.js';
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
export const DURATION_SNAPSHOT_CACHE = 'duration-snapshots.json';
export const AW_BREAKDOWN_CACHE = 'aw-breakdown.json';

export interface DurationSnapshot {
  snapshotId: string;
  totalMs: number;
  trackCount: number;
}

export type DurationSnapshots = Record<string, DurationSnapshot>;

export interface WeekBreakdownEntry {
  date: string; // dd.mm.yy release week
  addedAt: string; // dd.mm.yy date added to AW
  trackCount: number;
  durationMs: number;
  repeatArtists: number;
  repeatArtistTracks: number;
  frequentArtists: string[]; // artists with 3+ tracks this week
}

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

interface RawTrack {
  durationMs: number;
  artists: string[];
  addedAtDate: string; // YYYY-MM-DD or 'unknown'
}

/** Derive release Friday label from a track's release date, falling back to added_at. */
function trackFriday(releaseDate: string | undefined, addedAt: string): string {
  if (releaseDate) return formatDdMmYy(toReleaseFriday(new Date(releaseDate)));
  if (addedAt !== 'unknown') return formatDdMmYy(toReleaseFriday(new Date(addedAt)));
  return 'unknown';
}

/** Get all tracks from a playlist grouped by release week. */
export async function getPlaylistTracksGroupedByWeek(
  ctx: SpotifyContext,
  playlistId: string,
  onProgress?: (fetched: number, total: number) => void,
): Promise<WeekBreakdownEntry[]> {
  const byFriday = new Map<string, RawTrack[]>();
  // Track the most common added_at date per Friday group
  const addedAtCounts = new Map<string, Map<string, number>>();
  let offset = 0;
  const limit = 50;
  let total = 0;

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
      `playlist tracks grouped ${playlistId}`,
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      break;
    }

    if (offset === 0) total = result.data.total;

    for (const item of result.data.items) {
      if (!item.track) continue;
      const addedAt = (item as unknown as { added_at?: string }).added_at;
      const addedAtDate = addedAt ? addedAt.slice(0, 10) : 'unknown';
      const durationMs =
        (item.track as unknown as { duration_ms?: number }).duration_ms ?? 0;
      const artists = (
        item.track.artists as Array<{ name: string }>
      ).map((a) => a.name);
      const releaseDate = (
        item.track as unknown as { album?: { release_date?: string } }
      ).album?.release_date;

      const fri = trackFriday(releaseDate, addedAtDate);
      if (!byFriday.has(fri)) byFriday.set(fri, []);
      byFriday.get(fri)!.push({ durationMs, artists, addedAtDate });

      if (!addedAtCounts.has(fri)) addedAtCounts.set(fri, new Map());
      const counts = addedAtCounts.get(fri)!;
      counts.set(addedAtDate, (counts.get(addedAtDate) ?? 0) + 1);
    }

    offset += result.data.items.length;
    onProgress?.(offset, total);
    if (result.data.items.length < limit) break;
  }

  // Sort Fridays chronologically (pre-parse to avoid repeated parseDate calls)
  const sortedFridays = [...byFriday.keys()]
    .filter((f) => f !== 'unknown')
    .map((f) => ({ label: f, time: parseDate(f).getTime() }))
    .sort((a, b) => a.time - b.time)
    .map((f) => f.label);

  // Append unknown tracks to last group
  const unknownTracks = byFriday.get('unknown');
  if (unknownTracks?.length && sortedFridays.length > 0) {
    const lastFri = sortedFridays[sortedFridays.length - 1];
    byFriday.get(lastFri)!.push(...unknownTracks);
  } else if (unknownTracks?.length) {
    sortedFridays.push('unknown');
  }

  return sortedFridays.map((dateLabel) => {
    const tracks = byFriday.get(dateLabel)!;

    // Find the most common added_at date (inline max, no sort)
    const counts = addedAtCounts.get(dateLabel);
    let topAdded = 'unknown';
    let topCount = 0;
    if (counts) {
      for (const [date, count] of counts) {
        if (count > topCount) { topCount = count; topAdded = date; }
      }
    }
    const addedAt = topAdded === 'unknown'
      ? 'unknown'
      : formatDdMmYy(new Date(topAdded));

    const trackCount = tracks.length;
    const durationMs = tracks.reduce((s, t) => s + t.durationMs, 0);

    const artistCounts = new Map<string, number>();
    for (const t of tracks) {
      for (const a of t.artists) {
        artistCounts.set(a, (artistCounts.get(a) ?? 0) + 1);
      }
    }
    let repeatArtists = 0;
    let repeatArtistTracks = 0;
    const frequentArtists: string[] = [];
    for (const [name, count] of artistCounts) {
      if (count > 1) {
        repeatArtists++;
        repeatArtistTracks += count;
      }
      if (count >= 3) {
        frequentArtists.push(`${name} (${count})`);
      }
    }
    frequentArtists.sort();

    return { date: dateLabel, addedAt, trackCount, durationMs, repeatArtists, repeatArtistTracks, frequentArtists };
  });
}
