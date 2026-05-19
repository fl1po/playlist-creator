import type { SpotifyContext } from './spotify-context.js';
import { trackKey } from './track-utils.js';
import type {
  AlbumTrack,
  PlaylistAlbumInfo,
  SimplePlaylist,
} from './types.js';

type SpotifyInt = any; // Spotify SDK uses literal number union for limit/offset
type Item = any; // page items are loosely typed by the SDK

// ── Public types ─────────────────────────────────────────────────────────────

export interface PageOpts {
  /** Called after each page with cumulative progress. */
  onProgress?: (fetched: number, total: number) => void;
  /** Stop fetching after this offset is reached. */
  maxOffset?: number;
  /** Items per page (default: 50). */
  limit?: number;
  /** Cooperative cancellation. Checked before each fetch. */
  signal?: AbortSignal;
  /**
   * 'strict' (default): throw PaginationFailure on any non-auth failure.
   * 'partial': return whatever was accumulated when a page fails.
   * Auth errors always throw regardless of mode.
   */
  onError?: 'strict' | 'partial';
}

export class PaginationFailure extends Error {
  constructor(
    message: string,
    readonly cause: unknown,
    readonly partial: { fetched: number; total: number | null },
  ) {
    super(message);
    this.name = 'PaginationFailure';
  }
}

export interface PlaylistTrackDetailed {
  uri: string;
  name: string;
  key: string;
  artists: string;
}

export interface PlaylistTrackWithArtists {
  uri: string;
  id: string;
  name: string;
  artistNames: string[];
  albumId: string;
}

export interface TracksWithPositionsResult {
  artistData: Map<
    string,
    { positions: number[]; trackCount: number; id: string | null }
  >;
  totalTracks: number;
}

// ── Private engine ───────────────────────────────────────────────────────────

interface EngineOptions<TAcc> {
  fetch: (limit: SpotifyInt, offset: SpotifyInt) => Promise<unknown>;
  description: string;
  init: () => TAcc;
  onPage: (
    acc: TAcc,
    items: unknown[],
    meta: { offset: number; total: number; pageIndex: number },
  ) => void;
  opts?: PageOpts;
}

async function runPagination<TAcc>(
  ctx: SpotifyContext,
  engine: EngineOptions<TAcc>,
): Promise<TAcc> {
  const o = engine.opts ?? {};
  const limit = o.limit ?? 50;
  const errorMode = o.onError ?? 'strict';
  const acc = engine.init();
  let offset = 0;
  let total = 0;
  let pageIndex = 0;
  let totalKnown = false;

  while (true) {
    if (o.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    const result = await ctx.call(
      () => engine.fetch(limit, offset),
      engine.description,
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      if (errorMode === 'partial') return acc;
      throw new PaginationFailure(
        `pagination failed at offset ${offset} (${engine.description})`,
        result.error,
        { fetched: offset, total: totalKnown ? total : null },
      );
    }

    const page = result.data as { items?: unknown[]; total?: number };
    if (pageIndex === 0 && page.total != null) {
      total = page.total;
      totalKnown = true;
    }

    const items = (page.items ?? (result.data as unknown[])) as unknown[];
    engine.onPage(acc, items, { offset, total, pageIndex });

    const fetched = items.length;
    offset += fetched;
    o.onProgress?.(offset, total);

    if (fetched < limit) break;
    if (o.maxOffset != null && offset >= o.maxOffset) break;
    pageIndex++;
  }

  return acc;
}

// ── Escape hatches ───────────────────────────────────────────────────────────
// Prefer adding a named reader below to inlining one of these at a call site.

/** Paginate and collect mapped items. Return null from `map` to skip an item. */
export async function paginate<T>(
  ctx: SpotifyContext,
  source: {
    // `any` to accommodate Spotify SDK's literal-number union for limit/offset
    fetch: (limit: SpotifyInt, offset: SpotifyInt) => Promise<unknown>;
    description: string;
  },
  map: (
    item: unknown,
    ctx: { index: number; offset: number; total: number },
  ) => T | null,
  opts?: PageOpts,
): Promise<T[]> {
  let index = 0;
  return runPagination<T[]>(ctx, {
    fetch: source.fetch,
    description: source.description,
    init: () => [],
    onPage: (acc, items, meta) => {
      for (const item of items) {
        const mapped = map(item, {
          index: index++,
          offset: meta.offset,
          total: meta.total,
        });
        if (mapped !== null) acc.push(mapped);
      }
    },
    opts,
  });
}

/** Paginate and fold items into a custom accumulator (Map, struct, etc.). */
export async function paginateReduce<TAcc>(
  ctx: SpotifyContext,
  source: {
    // `any` to accommodate Spotify SDK's literal-number union for limit/offset
    fetch: (limit: SpotifyInt, offset: SpotifyInt) => Promise<unknown>;
    description: string;
  },
  init: () => TAcc,
  reduce: (
    acc: TAcc,
    item: unknown,
    ctx: { offset: number; total: number; pageIndex: number },
  ) => void,
  opts?: PageOpts,
): Promise<TAcc> {
  return runPagination<TAcc>(ctx, {
    fetch: source.fetch,
    description: source.description,
    init,
    onPage: (acc, items, meta) => {
      for (const item of items) reduce(acc, item, meta);
    },
    opts,
  });
}

// ── Named readers (the public API) ──────────────────────────────────────────

/** Get all track IDs from a playlist. */
export function getAllPlaylistTracks(
  ctx: SpotifyContext,
  playlistId: string,
  opts?: PageOpts,
): Promise<string[]> {
  return runPagination<string[]>(ctx, {
    fetch: (l, o) =>
      ctx.api.playlists.getPlaylistItems(
        playlistId,
        undefined,
        undefined,
        l,
        o,
      ),
    description: `playlist items ${playlistId}`,
    init: () => [],
    onPage: (acc, items) => {
      for (const item of items as Item[]) {
        if (item.track?.id) acc.push(item.track.id);
      }
    },
    opts,
  });
}

/** Get all playlists owned by a user. */
export function getAllUserPlaylists(
  ctx: SpotifyContext,
  userId: string,
  opts?: PageOpts,
): Promise<SimplePlaylist[]> {
  return runPagination<SimplePlaylist[]>(ctx, {
    fetch: (l, o) => ctx.api.playlists.getUsersPlaylists(userId, l, o),
    description: 'user playlists',
    init: () => [],
    onPage: (acc, items) => {
      for (const item of items as Item[]) {
        if (item.owner.id === userId) {
          acc.push({
            id: item.id,
            name: item.name,
            trackCount: item.tracks.total,
          });
        }
      }
    },
    opts,
  });
}

/** Get all tracks from an album with normalized dedup keys. */
export function getAlbumTracks(
  ctx: SpotifyContext,
  albumId: string,
  opts?: PageOpts,
): Promise<AlbumTrack[]> {
  return runPagination<AlbumTrack[]>(ctx, {
    fetch: (l, o) => ctx.api.albums.tracks(albumId, undefined, l, o),
    description: `tracks for album ${albumId}`,
    init: () => [],
    onPage: (acc, items) => {
      for (const item of items as Item[]) {
        const artistNames = item.artists.map((a: { name: string }) => a.name);
        acc.push({
          id: item.id,
          name: item.name,
          key: trackKey(artistNames, item.name),
          explicit: item.explicit as boolean | undefined,
        });
      }
    },
    opts,
  });
}

/** Get unique albums referenced by tracks in a playlist. */
export function getPlaylistAlbums(
  ctx: SpotifyContext,
  playlistId: string,
  opts?: PageOpts,
): Promise<Map<string, PlaylistAlbumInfo>> {
  return runPagination<Map<string, PlaylistAlbumInfo>>(ctx, {
    fetch: (l, o) =>
      ctx.api.playlists.getPlaylistItems(
        playlistId,
        undefined,
        undefined,
        l,
        o,
      ),
    description: `editorial playlist ${playlistId}`,
    init: () => new Map(),
    onPage: (acc, items) => {
      for (const item of items as Item[]) {
        if (item.track?.album) {
          const albumId = item.track.album.id;
          if (!acc.has(albumId)) {
            acc.set(albumId, {
              id: albumId,
              name: item.track.album.name,
              artistName: item.track.artists?.[0]?.name ?? 'Unknown',
            });
          }
        }
      }
    },
    opts: { maxOffset: 200, ...opts },
  });
}

/** Get all tracks from a playlist with normalized dedup keys. */
export function getPlaylistTracksDetailed(
  ctx: SpotifyContext,
  playlistId: string,
  opts?: PageOpts,
): Promise<PlaylistTrackDetailed[]> {
  return runPagination<PlaylistTrackDetailed[]>(ctx, {
    fetch: (l, o) =>
      ctx.api.playlists.getPlaylistItems(
        playlistId,
        undefined,
        undefined,
        l,
        o,
      ),
    description: `playlist items ${playlistId}`,
    init: () => [],
    onPage: (acc, items) => {
      for (const item of items as Item[]) {
        if (!item.track?.id) continue;
        const trackArtists: Array<{ name: string }> = item.track.artists ?? [];
        const artistNames = trackArtists.map((a) => a.name);
        acc.push({
          uri: item.track.uri,
          name: item.track.name,
          key: trackKey(artistNames, item.track.name),
          artists: artistNames.join(', '),
        });
      }
    },
    opts,
  });
}

/** Get all tracks from a playlist with individual artist names (not comma-joined). */
export function getPlaylistTracksWithArtists(
  ctx: SpotifyContext,
  playlistId: string,
  opts?: PageOpts,
): Promise<PlaylistTrackWithArtists[]> {
  return runPagination<PlaylistTrackWithArtists[]>(ctx, {
    fetch: (l, o) =>
      ctx.api.playlists.getPlaylistItems(
        playlistId,
        undefined,
        undefined,
        l,
        o,
      ),
    description: `playlist items ${playlistId}`,
    init: () => [],
    onPage: (acc, items) => {
      for (const item of items as Item[]) {
        if (!item.track?.id) continue;
        acc.push({
          uri: item.track.uri,
          id: item.track.id,
          name: item.track.name,
          artistNames: (item.track.artists ?? []).map(
            (a: { name: string }) => a.name,
          ),
          albumId: item.track.album?.id ?? '',
        });
      }
    },
    opts,
  });
}

/** Get total duration of all tracks in a playlist. */
export function getPlaylistTotalDuration(
  ctx: SpotifyContext,
  playlistId: string,
  opts?: PageOpts,
): Promise<{ totalMs: number; trackCount: number }> {
  return runPagination<{ totalMs: number; trackCount: number }>(ctx, {
    fetch: (l, o) =>
      ctx.api.playlists.getPlaylistItems(
        playlistId,
        undefined,
        undefined,
        l,
        o,
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
    opts,
  });
}

function paginateTracksWithPositions(
  ctx: SpotifyContext,
  source: {
    fetch: (limit: SpotifyInt, offset: SpotifyInt) => Promise<unknown>;
    description: string;
    invertPositions?: boolean;
  },
  opts?: PageOpts,
): Promise<TracksWithPositionsResult> {
  let position = 0;
  return runPagination<TracksWithPositionsResult>(ctx, {
    fetch: source.fetch,
    description: source.description,
    init: () => ({ artistData: new Map(), totalTracks: 0 }),
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
    opts,
  });
}

/** Scan playlist tracks with position info for recency calculations. */
export function getPlaylistTracksWithPositions(
  ctx: SpotifyContext,
  playlistId: string,
  opts?: PageOpts,
): Promise<TracksWithPositionsResult> {
  return paginateTracksWithPositions(
    ctx,
    {
      fetch: (l, o) =>
        ctx.api.playlists.getPlaylistItems(
          playlistId,
          undefined,
          undefined,
          l,
          o,
        ),
      description: `playlist tracks with positions ${playlistId}`,
    },
    opts,
  );
}

/**
 * Scan Liked Songs (saved tracks) with position info for recency calculations.
 * Liked Songs are newest-first, so positions are inverted to match playlist
 * convention (higher position = more recent).
 */
export function getLikedTracksWithPositions(
  ctx: SpotifyContext,
  opts?: PageOpts,
): Promise<TracksWithPositionsResult> {
  return paginateTracksWithPositions(
    ctx,
    {
      fetch: (l, o) => ctx.api.currentUser.tracks.savedTracks(l, o),
      description: 'liked songs with positions',
      invertPositions: true,
    },
    opts,
  );
}
