import type { SpotifyApi } from '@spotify/web-api-ts-sdk';
import type { SpotifyGateway } from './spotify/gateway.js';
import { trackKey } from './track-utils.js';
import type { AlbumTrack, PlaylistAlbumInfo, SimplePlaylist } from './types.js';

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

// ── Private engine ───────────────────────────────────────────────────────────

interface EngineOptions<TAcc> {
  fetch: (
    api: SpotifyApi,
    limit: SpotifyInt,
    offset: SpotifyInt,
  ) => Promise<unknown>;
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
  ctx: SpotifyGateway,
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
      (api) => engine.fetch(api, limit, offset),
      engine.description,
    );

    if (!result.success) {
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

    // Tolerate fetchers that return a bare array rather than a paging object.
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
  ctx: SpotifyGateway,
  source: {
    fetch: (
      api: SpotifyApi,
      limit: SpotifyInt,
      offset: SpotifyInt,
    ) => Promise<unknown>;
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
  ctx: SpotifyGateway,
  source: {
    fetch: (
      api: SpotifyApi,
      limit: SpotifyInt,
      offset: SpotifyInt,
    ) => Promise<unknown>;
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

/** Get all playlists owned by a user. */
export function getAllUserPlaylists(
  ctx: SpotifyGateway,
  userId: string,
  opts?: PageOpts,
): Promise<SimplePlaylist[]> {
  return runPagination<SimplePlaylist[]>(ctx, {
    fetch: (api, l, o) => api.playlists.getUsersPlaylists(userId, l, o),
    description: 'user playlists',
    init: () => [],
    onPage: (acc, items) => {
      for (const item of items as Item[]) {
        if (item.owner.id === userId) {
          acc.push({
            id: item.id,
            name: item.name,
            trackCount: item.tracks.total,
            snapshotId: item.snapshot_id,
            description: item.description || undefined,
          });
        }
      }
    },
    opts,
  });
}

/** Get all tracks from an album with normalized dedup keys. */
export function getAlbumTracks(
  ctx: SpotifyGateway,
  albumId: string,
  opts?: PageOpts,
): Promise<AlbumTrack[]> {
  return runPagination<AlbumTrack[]>(ctx, {
    fetch: (api, l, o) => api.albums.tracks(albumId, undefined, l, o),
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
  ctx: SpotifyGateway,
  playlistId: string,
  opts?: PageOpts,
): Promise<Map<string, PlaylistAlbumInfo>> {
  return runPagination<Map<string, PlaylistAlbumInfo>>(ctx, {
    fetch: (api, l, o) =>
      api.playlists.getPlaylistItems(playlistId, undefined, undefined, l, o),
    description: `editorial playlist ${playlistId}`,
    init: () => new Map(),
    onPage: (acc, items) => {
      for (const item of items as Item[]) {
        if (item.track?.album) {
          const album = item.track.album;
          if (!acc.has(album.id)) {
            acc.set(album.id, {
              id: album.id,
              name: album.name,
              artistName: item.track.artists?.[0]?.name ?? 'Unknown',
              artistIds: (album.artists ?? []).map((a: { id: string }) => a.id),
              releaseDate: album.release_date,
              albumType: album.album_type,
              totalTracks: album.total_tracks,
            });
          }
        }
      }
    },
    opts: { maxOffset: 200, ...opts },
  });
}
