import type { PriorityChange } from '../services/promotion-sync/index.js';
import type { AiPicksRecord } from '../services/week-collection/index.js';
import type { DeezerTopTrack } from './deezer-client.js';
import type { CacheDescriptor } from './durable-cache.js';
import type {
  BatchCache,
  RecalculationState,
  TrustedArtistsFile,
} from './types.js';

export const LISTENING_TIME_CACHE = 'listening-time-cache.json';
export const DURATION_SNAPSHOT_CACHE = 'duration-snapshots.json';
export const AW_BREAKDOWN_CACHE = 'aw-breakdown.json';

export interface DurationSnapshot {
  snapshotId: string;
  totalMs: number;
  trackCount: number;
}

export type DurationSnapshots = Record<string, DurationSnapshot>;

export const TRUSTED_ARTISTS: CacheDescriptor<TrustedArtistsFile> = {
  redisName: 'trustedArtists',
  file: 'trusted-artists.json',
};

export const BATCH_CACHE: CacheDescriptor<BatchCache> = {
  redisName: 'batchCache',
  file: 'batch-cache.json',
  isEmpty: (v) => !v || Object.keys(v).length === 0,
  // Hundreds of KB, re-saved every 50 artists of a fill; the page never reads it.
  browserMirror: false,
};

/** Owned by the Recalculation module: source snapshots + reusable scans. */
export const RECALCULATION_STATE: CacheDescriptor<RecalculationState> = {
  redisName: 'recalculationState',
  file: 'recalculation-state.json',
  isEmpty: (v) => !v || Object.keys(v).length === 0,
};

/** Owned by the Recalculation module: priority changes awaiting promotion sync. */
export const PENDING_PRIORITY_CHANGES: CacheDescriptor<PriorityChange[]> = {
  redisName: 'pendingPriorityChanges',
  file: 'pending-priority-changes.json',
  isEmpty: (v) => !Array.isArray(v) || v.length === 0,
};

export const FILL_HISTORY: CacheDescriptor<unknown[]> = {
  redisName: 'fillHistory',
  file: 'fill-history.json',
  isEmpty: (v) => !Array.isArray(v) || v.length === 0,
};

export const DURATION_SNAPSHOTS: CacheDescriptor<DurationSnapshots> = {
  redisName: 'durationSnapshots',
  file: DURATION_SNAPSHOT_CACHE,
};

export const LISTENING_TIME: CacheDescriptor<unknown> = {
  redisName: 'listeningTime',
  file: LISTENING_TIME_CACHE,
};

export const AW_BREAKDOWN: CacheDescriptor<unknown> = {
  redisName: 'awBreakdown',
  file: AW_BREAKDOWN_CACHE,
};

export const NON_LISTENED: CacheDescriptor<unknown> = {
  redisName: 'nonListened',
  file: 'non-listened-cache.json',
};

/** Each opted-in week's AI picks or skip reason, keyed by weekly playlist date. */
export const AI_PICKS: CacheDescriptor<Record<string, AiPicksRecord>> = {
  redisName: 'aiPicks',
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

export const DEEZER_ARTISTS: CacheDescriptor<DeezerArtistCache> = {
  redisName: 'deezerArtists',
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
 * P1/P2 stay put. Too large for the browser, and Redis may refuse it: the
 * file is authoritative.
 */
export const RELATED_ARTIST_GRAPH: CacheDescriptor<
  Record<string, RelatedArtistEntry>
> = {
  redisName: 'relatedArtistGraph',
  file: 'related-artist-graph.json',
  isEmpty: (v) => !v || Object.keys(v).length === 0,
  browserMirror: false,
};
