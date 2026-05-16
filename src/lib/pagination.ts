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

// ── Core pagination primitive ─────────────────────────────────────────────────

type SpotifyInt = any; // Spotify SDK uses literal number union for limit/offset

interface PaginateOptions<TAcc> {
  /** The raw API call to make (will be wrapped with ctx.call). */
  fetch: (limit: SpotifyInt, offset: SpotifyInt) => Promise<unknown>;
  /** Description for ctx.call logging. */
  description: string;
  /** Items per page (default: 50). */
  limit?: number;
  /** Stop fetching after this offset is reached. */
  maxOffset?: number;
  /** Create initial accumulator. */
  init: () => TAcc;
  /** Process one page of items into the accumulator. */
  onPage: (
    acc: TAcc,
    items: unknown[],
    meta: { offset: number; total: number; pageIndex: number },
  ) => void;
  /** Called after each page with progress info. */
  onProgress?: (fetched: number, total: number) => void;
}

/**
 * Core pagination loop. Handles offset tracking, error semantics
 * (throw on authError, return partial accumulator on other failures),
 * and termination (items < limit or maxOffset reached).
 */
export async function paginateWith<TAcc>(
  ctx: SpotifyContext,
  opts: PaginateOptions<TAcc>,
): Promise<TAcc> {
  const limit = opts.limit ?? 50;
  const acc = opts.init();
  let offset = 0;
  let total = 0;
  let pageIndex = 0;

  while (true) {
    const result = await ctx.call(
      () => opts.fetch(limit, offset),
      opts.description,
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      return acc;
    }

    const page = result.data as { items?: unknown[]; total?: number };
    if (pageIndex === 0 && page.total != null) {
      total = page.total;
    }

    const items = (page.items ?? (result.data as unknown[])) as unknown[];
    opts.onPage(acc, items, { offset, total, pageIndex });

    const fetched = items.length;
    offset += fetched;
    opts.onProgress?.(offset, total);

    if (fetched < limit) break;
    if (opts.maxOffset != null && offset >= opts.maxOffset) break;
    pageIndex++;
  }

  return acc;
}

/**
 * Fetch all items from a playlist and map each to a value.
 * Return null from the map function to skip an item.
 */
export async function fetchAll<T>(
  ctx: SpotifyContext,
  playlistId: string,
  map: (item: unknown, index: number) => T | null,
  opts?: {
    limit?: number;
    maxOffset?: number;
    onProgress?: (fetched: number, total: number) => void;
  },
): Promise<T[]> {
  let index = 0;
  return paginateWith(ctx, {
    fetch: (limit, offset) =>
      ctx.api.playlists.getPlaylistItems(
        playlistId,
        undefined,
        undefined,
        limit,
        offset,
      ),
    description: `playlist items ${playlistId}`,
    limit: opts?.limit,
    maxOffset: opts?.maxOffset,
    init: () => [] as T[],
    onPage: (acc, items) => {
      for (const item of items) {
        const mapped = map(item, index++);
        if (mapped !== null) acc.push(mapped);
      }
    },
    onProgress: opts?.onProgress,
  });
}

/**
 * Fetch all items from an arbitrary paginated endpoint and map each to a value.
 * Return null from the map function to skip an item.
 */
export async function fetchAllFrom<T>(
  ctx: SpotifyContext,
  source: {
    fetch: (limit: SpotifyInt, offset: SpotifyInt) => Promise<unknown>;
    description: string;
    limit?: number;
  },
  map: (item: unknown, index: number) => T | null,
): Promise<T[]> {
  let index = 0;
  return paginateWith(ctx, {
    fetch: source.fetch,
    description: source.description,
    limit: source.limit,
    init: () => [] as T[],
    onPage: (acc, items) => {
      for (const item of items) {
        const mapped = map(item, index++);
        if (mapped !== null) acc.push(mapped);
      }
    },
  });
}

// ── Playlist functions (using pagination primitives) ──────────────────────────

type Item = any; // Spotify SDK types are untyped at item level

/** Get all track IDs from a playlist. */
export async function getAllPlaylistTracks(
  ctx: SpotifyContext,
  playlistId: string,
): Promise<string[]> {
  return fetchAll(ctx, playlistId, (item: Item) => item.track?.id ?? null);
}

/** Get all playlists owned by a user. */
export async function getAllUserPlaylists(
  ctx: SpotifyContext,
  userId: string,
): Promise<SimplePlaylist[]> {
  return fetchAllFrom(
    ctx,
    {
      fetch: (limit, offset) =>
        ctx.api.playlists.getUsersPlaylists(userId, limit, offset),
      description: 'user playlists',
    },
    (item: Item) =>
      item.owner.id === userId
        ? { id: item.id, name: item.name, trackCount: item.tracks.total }
        : null,
  );
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

export interface FrequentArtistEntry {
  label: string; // "Artist (N)"
  album: string; // album name for tooltip
}

export interface WeekBreakdownEntry {
  date: string; // dd.mm.yy release week
  addedAt: string; // dd.mm.yy date added to AW
  trackCount: number;
  durationMs: number;
  albumCount: number;
  albumTracks: number;
  frequentArtists: FrequentArtistEntry[];
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
      emit(`Using cached non-listened playlists (${cached.playlists.length})`);
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
    .sort((a, b) => parseDate(b.name).getTime() - parseDate(a.name).getTime()); // newest first

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
  return fetchAllFrom(
    ctx,
    {
      fetch: (limit, offset) =>
        ctx.api.albums.tracks(albumId, undefined, limit, offset),
      description: `tracks for album ${albumId}`,
    },
    (item: Item) => {
      const artistNames = item.artists.map((a: { name: string }) => a.name);
      return {
        id: item.id,
        name: item.name,
        key: trackKey(artistNames, item.name),
        explicit: item.explicit as boolean | undefined,
      };
    },
  );
}

/** Get unique albums referenced by tracks in a playlist. */
export async function getPlaylistAlbums(
  ctx: SpotifyContext,
  playlistId: string,
  maxOffset = 200,
): Promise<Map<string, PlaylistAlbumInfo>> {
  return paginateWith(ctx, {
    fetch: (limit, offset) =>
      ctx.api.playlists.getPlaylistItems(
        playlistId,
        undefined,
        undefined,
        limit,
        offset,
      ),
    description: `editorial playlist ${playlistId}`,
    maxOffset,
    init: () => new Map<string, PlaylistAlbumInfo>(),
    onPage: (albums, items) => {
      for (const item of items as Item[]) {
        if (item.track?.album) {
          const albumId = item.track.album.id;
          if (!albums.has(albumId)) {
            albums.set(albumId, {
              id: albumId,
              name: item.track.album.name,
              artistName: item.track.artists?.[0]?.name ?? 'Unknown',
            });
          }
        }
      }
    },
  });
}

/** Get all tracks from a playlist with normalized dedup keys. */
export async function getPlaylistTracksDetailed(
  ctx: SpotifyContext,
  playlistId: string,
): Promise<Array<{ uri: string; name: string; key: string; artists: string }>> {
  return fetchAll(ctx, playlistId, (item: Item) => {
    if (!item.track?.id) return null;
    const trackArtists: Array<{ name: string }> = item.track.artists ?? [];
    const artistNames = trackArtists.map((a) => a.name);
    return {
      uri: item.track.uri,
      name: item.track.name,
      key: trackKey(artistNames, item.track.name),
      artists: artistNames.join(', '),
    };
  });
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
  return fetchAll(ctx, playlistId, (item: Item) => {
    if (!item.track?.id) return null;
    return {
      uri: item.track.uri,
      id: item.track.id,
      name: item.track.name,
      artistNames: (item.track.artists ?? []).map(
        (a: { name: string }) => a.name,
      ),
      albumId: item.track.album?.id ?? '',
    };
  });
}

/** Get total duration of all tracks in a playlist. */
export async function getPlaylistTotalDuration(
  ctx: SpotifyContext,
  playlistId: string,
): Promise<{ totalMs: number; trackCount: number }> {
  return paginateWith(ctx, {
    fetch: (limit, offset) =>
      ctx.api.playlists.getPlaylistItems(
        playlistId,
        undefined,
        undefined,
        limit,
        offset,
      ),
    description: `playlist duration ${playlistId}`,
    init: () => ({ totalMs: 0, trackCount: 0 }),
    onPage: (acc, items) => {
      for (const item of items as Item[]) {
        if (item.track) {
          acc.totalMs += item.track.duration_ms ?? 0;
          acc.trackCount++;
        }
      }
    },
  });
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

type TracksWithPositionsResult = {
  artistData: Map<
    string,
    { positions: number[]; trackCount: number; id: string | null }
  >;
  totalTracks: number;
};

function paginateTracksWithPositions(
  ctx: SpotifyContext,
  source: {
    fetch: (limit: SpotifyInt, offset: SpotifyInt) => Promise<unknown>;
    description: string;
    invertPositions?: boolean;
  },
  onProgress?: (fetched: number, total: number) => void,
): Promise<TracksWithPositionsResult> {
  let position = 0;
  return paginateWith(ctx, {
    fetch: source.fetch,
    description: source.description,
    init: (): TracksWithPositionsResult => ({
      artistData: new Map(),
      totalTracks: 0,
    }),
    onPage: (acc, items, { total, pageIndex }) => {
      if (pageIndex === 0) acc.totalTracks = total;
      for (const item of items as Item[]) {
        const track = item.track;
        if (track?.artists) {
          const logicalPosition = source.invertPositions
            ? total - 1 - position
            : position;
          for (const artist of track.artists as Array<{
            id: string;
            name: string;
          }>) {
            let data = acc.artistData.get(artist.name);
            if (!data) {
              data = { positions: [], trackCount: 0, id: artist.id };
              acc.artistData.set(artist.name, data);
            }
            data.positions.push(logicalPosition);
            data.trackCount++;
          }
        }
        position++;
      }
    },
    onProgress,
  });
}

/** Scan playlist tracks with position info for recency calculations. */
export function getPlaylistTracksWithPositions(
  ctx: SpotifyContext,
  playlistId: string,
  onProgress?: (fetched: number, total: number) => void,
): Promise<TracksWithPositionsResult> {
  return paginateTracksWithPositions(
    ctx,
    {
      fetch: (limit, offset) =>
        ctx.api.playlists.getPlaylistItems(
          playlistId,
          undefined,
          undefined,
          limit,
          offset,
        ),
      description: `playlist tracks with positions ${playlistId}`,
    },
    onProgress,
  );
}

/**
 * Scan Liked Songs (saved tracks) with position info for recency calculations.
 * Liked Songs are newest-first, so positions are inverted to match playlist
 * convention (higher position = more recent).
 */
export function getLikedTracksWithPositions(
  ctx: SpotifyContext,
  onProgress?: (fetched: number, total: number) => void,
): Promise<TracksWithPositionsResult> {
  return paginateTracksWithPositions(
    ctx,
    {
      fetch: (limit, offset) =>
        ctx.api.currentUser.tracks.savedTracks(limit, offset),
      description: 'liked songs with positions',
      invertPositions: true,
    },
    onProgress,
  );
}

// ── Weekly breakdown ──────────────────────────────────────────────────────────

interface RawTrack {
  durationMs: number;
  artists: string[];
  albumId: string;
  albumArtist: string;
  albumName: string;
  addedAtDate: string; // YYYY-MM-DD or 'unknown'
}

/** Derive release Friday label from a track's release date, falling back to added_at. */
function trackFriday(releaseDate: string | undefined, addedAt: string): string {
  if (releaseDate) return formatDdMmYy(toReleaseFriday(new Date(releaseDate)));
  if (addedAt !== 'unknown')
    return formatDdMmYy(toReleaseFriday(new Date(addedAt)));
  return 'unknown';
}

/** Get all tracks from a playlist grouped by release week. */
export async function getPlaylistTracksGroupedByWeek(
  ctx: SpotifyContext,
  playlistId: string,
  onProgress?: (fetched: number, total: number) => void,
): Promise<WeekBreakdownEntry[]> {
  const { byFriday, addedAtCounts } = await paginateWith(ctx, {
    fetch: (limit, offset) =>
      ctx.api.playlists.getPlaylistItems(
        playlistId,
        undefined,
        undefined,
        limit,
        offset,
      ),
    description: `playlist tracks grouped ${playlistId}`,
    init: () => ({
      byFriday: new Map<string, RawTrack[]>(),
      addedAtCounts: new Map<string, Map<string, number>>(),
    }),
    onPage: (acc, items) => {
      for (const item of items as Item[]) {
        if (!item.track) continue;
        const addedAt = item.added_at as string | undefined;
        const addedAtDate = addedAt ? addedAt.slice(0, 10) : 'unknown';
        const durationMs = item.track.duration_ms ?? 0;
        const artists = (item.track.artists as Array<{ name: string }>).map(
          (a) => a.name,
        );
        const album = item.track.album as
          | {
              id?: string;
              name?: string;
              release_date?: string;
              artists?: Array<{ name: string }>;
            }
          | undefined;
        const releaseDate = album?.release_date;
        const albumId = album?.id ?? '';
        const albumArtist = album?.artists?.[0]?.name ?? '';
        const albumName = album?.name ?? '';

        const fri = trackFriday(releaseDate, addedAtDate);
        if (!acc.byFriday.has(fri)) acc.byFriday.set(fri, []);
        acc.byFriday.get(fri)?.push({
          durationMs,
          artists,
          albumId,
          albumArtist,
          albumName,
          addedAtDate,
        });

        if (!acc.addedAtCounts.has(fri)) acc.addedAtCounts.set(fri, new Map());
        const counts = acc.addedAtCounts.get(fri);
        counts?.set(addedAtDate, (counts.get(addedAtDate) ?? 0) + 1);
      }
    },
    onProgress,
  });

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
    byFriday.get(lastFri)?.push(...unknownTracks);
  } else if (unknownTracks?.length) {
    sortedFridays.push('unknown');
  }

  return sortedFridays.map((dateLabel) => {
    const tracks = byFriday.get(dateLabel) ?? [];

    // Find the most common added_at date (inline max, no sort)
    const counts = addedAtCounts.get(dateLabel);
    let topAdded = 'unknown';
    let topCount = 0;
    if (counts) {
      for (const [date, count] of counts) {
        if (count > topCount) {
          topCount = count;
          topAdded = date;
        }
      }
    }
    const addedAt =
      topAdded === 'unknown' ? 'unknown' : formatDdMmYy(new Date(topAdded));

    const trackCount = tracks.length;
    const durationMs = tracks.reduce((s, t) => s + t.durationMs, 0);

    // Group by album — find albums with 3+ tracks, show the main artist
    const albumTrackCounts = new Map<string, number>();
    const albumMeta = new Map<string, { artist: string; name: string }>();
    for (const t of tracks) {
      if (!t.albumId) continue;
      albumTrackCounts.set(
        t.albumId,
        (albumTrackCounts.get(t.albumId) ?? 0) + 1,
      );
      if (!albumMeta.has(t.albumId))
        albumMeta.set(t.albumId, { artist: t.albumArtist, name: t.albumName });
    }
    const repeatAlbumIds = new Set<string>();
    const frequentEntries: { artist: string; album: string; count: number }[] =
      [];
    for (const [albumId, count] of albumTrackCounts) {
      if (count < 3) continue;
      repeatAlbumIds.add(albumId);
      const meta = albumMeta.get(albumId);
      if (meta)
        frequentEntries.push({ artist: meta.artist, album: meta.name, count });
    }
    frequentEntries.sort(
      (a, b) => b.count - a.count || a.artist.localeCompare(b.artist),
    );
    const frequentArtists: FrequentArtistEntry[] = frequentEntries.map((e) => ({
      label: `${e.artist} (${e.count})`,
      album: e.album,
    }));
    const albumCount = repeatAlbumIds.size;
    let albumTracks = 0;
    for (const t of tracks) {
      if (t.albumId && repeatAlbumIds.has(t.albumId)) albumTracks++;
    }

    return {
      date: dateLabel,
      addedAt,
      trackCount,
      durationMs,
      albumCount,
      albumTracks,
      frequentArtists,
    };
  });
}
