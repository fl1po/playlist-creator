import type { PriorityChange } from '../../services/promotion-sync/index.js';
import type { AiPicksRecord } from '../../services/week-collection/index.js';
import type { DeezerTopTrack } from '../deezer-client.js';
import type {
  BatchCache,
  RecalculationState,
  TrustedArtistsFile,
} from '../types.js';
import type { UserConfig } from '../user-config.js';

/** One named piece of user data (CONTEXT.md). */
export interface Dataset<T> {
  /** Redis key prefix; final key is `${name}:${userId}`. */
  readonly name: string;
  /** Filename inside the user's data dir. */
  readonly file: string;
  /**
   * A value that parsed fine but must still be treated as "none yet" (e.g.
   * `{}` for batchCache, which should fall through to Redis). Defaults to
   * `value == null`.
   */
  isEmpty?(value: T): boolean;
}

/** Read through `UserData.config`, which merges in the defaults. */
export const CONFIG: Dataset<Partial<UserConfig>> = {
  name: 'config',
  file: 'user-config.json',
};

export const TRUSTED_ARTISTS: Dataset<TrustedArtistsFile> = {
  name: 'trustedArtists',
  file: 'trusted-artists.json',
};

export const BATCH_CACHE: Dataset<BatchCache> = {
  name: 'batchCache',
  file: 'batch-cache.json',
  isEmpty: (v) => !v || Object.keys(v).length === 0,
};

/** Owned by the Recalculation module: source snapshots + reusable scans. */
export const RECALCULATION_STATE: Dataset<RecalculationState> = {
  name: 'recalculationState',
  file: 'recalculation-state.json',
  isEmpty: (v) => !v || Object.keys(v).length === 0,
};

/** Owned by the Recalculation module: priority changes awaiting promotion sync. */
export const PENDING_PRIORITY_CHANGES: Dataset<PriorityChange[]> = {
  name: 'pendingPriorityChanges',
  file: 'pending-priority-changes.json',
  isEmpty: (v) => !Array.isArray(v) || v.length === 0,
};

export const FILL_HISTORY: Dataset<unknown[]> = {
  name: 'fillHistory',
  file: 'fill-history.json',
  isEmpty: (v) => !Array.isArray(v) || v.length === 0,
};

export const LISTENING_TIME: Dataset<unknown> = {
  name: 'listeningTime',
  file: 'listening-time-cache.json',
};

export const AW_BREAKDOWN: Dataset<unknown> = {
  name: 'awBreakdown',
  file: 'aw-breakdown.json',
};

/**
 * One playlist's items as of one snapshot, in the playlist reads module's
 * compact encoding. `readAt` (ms) drives pruning of entries nobody reads.
 */
export interface StoredPlaylistTracks {
  snapshot: string;
  readAt: number;
  items: unknown[];
}

/** Owned by the playlist reads module: tracks by playlist id (ADR-0011). */
export const PLAYLIST_TRACKS: Dataset<Record<string, StoredPlaylistTracks>> = {
  name: 'playlistTracks',
  file: 'playlist-tracks.json',
  isEmpty: (v) => !v || Object.keys(v).length === 0,
};

/**
 * Owned by the playlist reads module: Liked Songs, newest first, keyed by
 * `total:newest added_at` since Liked Songs has no snapshot id (ADR-0011).
 */
export const LIKED_SONGS_TRACKS: Dataset<StoredPlaylistTracks> = {
  name: 'likedSongsTracks',
  file: 'liked-songs-tracks.json',
};

/** Each opted-in week's AI picks or skip reason, keyed by weekly playlist date. */
export const AI_PICKS: Dataset<Record<string, AiPicksRecord>> = {
  name: 'aiPicks',
  file: 'ai-picks.json',
  isEmpty: (v) => !v || Object.keys(v).length === 0,
};

/**
 * Owned by the Deezer CandidateSource: roster and reject artists resolved on
 * Deezer (null when Deezer has none), and each pool artist's top tracks for
 * relative popularity. Keyed by folded name and Deezer artist id.
 */
export interface DeezerArtistCache {
  artists: Record<
    string,
    { deezer: { id: number; fans: number } | null; fetchedAt: number }
  >;
  topTracks: Record<string, { tracks: DeezerTopTrack[]; fetchedAt: number }>;
}

export const DEEZER_ARTISTS: Dataset<DeezerArtistCache> = {
  name: 'deezerArtists',
  file: 'deezer-artists.json',
};

/** A Deezer artist named as related to a seed; fans as of the fetch. */
export interface RelatedArtist {
  id: number;
  name: string;
  fans: number;
}

/**
 * One P1/P2 seed's related artists on Deezer. `deezerId: null` means Deezer
 * has no such artist. A failed lookup is never stored.
 */
export interface RelatedArtistEntry {
  deezerId: number | null;
  related: RelatedArtist[];
  fetchedAt: number;
}

/**
 * Owned by the Deezer CandidateSource: the related-artist graph, one entry
 * per seed keyed by Spotify id (folded name when it has none). Co-citation
 * is worked out on read from the current seeds; entries for seeds no longer
 * P1/P2 stay put. Redis may refuse it for size: the file is authoritative.
 */
export const RELATED_ARTIST_GRAPH: Dataset<Record<string, RelatedArtistEntry>> =
  {
    name: 'relatedArtistGraph',
    file: 'related-artist-graph.json',
    isEmpty: (v) => !v || Object.keys(v).length === 0,
  };

/** The catalogue: every dataset a user has. `copyUserData` walks it. */
export const DATASETS: ReadonlyArray<Dataset<unknown>> = [
  CONFIG,
  TRUSTED_ARTISTS,
  BATCH_CACHE,
  RECALCULATION_STATE,
  PENDING_PRIORITY_CHANGES,
  FILL_HISTORY,
  LISTENING_TIME,
  AW_BREAKDOWN,
  PLAYLIST_TRACKS,
  LIKED_SONGS_TRACKS,
  AI_PICKS,
  DEEZER_ARTISTS,
  RELATED_ARTIST_GRAPH,
] as ReadonlyArray<Dataset<unknown>>;
