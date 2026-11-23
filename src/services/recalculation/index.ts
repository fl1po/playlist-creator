import type {
  PlaylistItem,
  PlaylistRead,
  PlaylistReads,
} from '../../lib/playlist-reads/index.js';
import type {
  PlaylistArtistData,
  PlaylistScanResult,
  SimplePlaylist,
  TrustedArtistsFile,
} from '../../lib/types.js';
import { secondarySourceName, type UserConfig } from '../../lib/user-config.js';
import {
  PENDING_PRIORITY_CHANGES,
  RECALCULATION_STATE,
  TRUSTED_ARTISTS,
} from '../../lib/user-data/index.js';
import type { UserSession } from '../../lib/user-session.js';
import {
  type PriorityChange,
  type PromotionProgressEvent,
  type PromotionSyncPorts,
  type PromotionSyncResult,
  syncPriorityChanges,
} from '../promotion-sync/index.js';
import { spotifyRecalculationPorts } from './adapters.js';
import { scoreRoster } from './score.js';

/*
 * Recalculation: re-scoring every artist in the source playlists into the
 * trusted artists roster, and — separately — applying the resulting priority
 * changes to already-published weekly playlists through promotion sync.
 *
 * `recalculate` never syncs. It saves the roster together with the pending
 * priority changes; `syncPending` is the only way they reach the playlists,
 * and clears them only once it succeeds. So an abort or a failed sync defers
 * the sync instead of losing it (ADR-0002).
 */

// ── Ports (the seam) ─────────────────────────────────────────────────────────

export type Source = 'aw' | 'boaw';

/**
 * The unprocessed weekly playlists promotion sync reconciles. Always current:
 * a sync's own writes show up in the next `find` with nothing to invalidate.
 */
export interface UnprocessedPlaylists {
  find(
    allWeeklyId: string,
    log: (message: string, level?: 'info' | 'debug') => void,
  ): Promise<{ playlists: SimplePlaylist[]; awTrackIds: Set<string> }>;
}

/**
 * The two source playlists, All Weekly and BoAW (Liked Songs when the user
 * says so), are read through playlist reads itself (ADR-0013): an unchanged
 * source costs one snapshot call and no item pages.
 */
export interface RecalculationPorts {
  playlists: PlaylistReads;
  unprocessed: UnprocessedPlaylists;
  sync: PromotionSyncPorts;
}

// ── Progress + results ───────────────────────────────────────────────────────

/**
 * Liveness only — results come back as data. Both sources are read before
 * recalculation knows whether to re-score, so a read reports only its pages
 * and its end; `recalculating` and each source's `scan-done` follow only
 * when it does re-score. An unchanged run says nothing.
 */
export type RecalculationProgress =
  | {
      phase: 'scan-progress';
      source: Source;
      name: string;
      fetched: number;
      total: number;
    }
  /** A source's read ended, fetched or not. */
  | { phase: 'scan-read'; source: Source; name: string }
  | { phase: 'recalculating' }
  | {
      phase: 'scan-done';
      source: Source;
      name: string;
      artists: number;
      tracks: number;
      cached: boolean;
      /** Items Spotify counted but left out; the source is scored again next run. */
      missing: number;
    };

export type SyncProgress =
  | PromotionProgressEvent
  | { phase: 'log'; message: string; level: 'info' | 'debug' }
  /** The sync succeeded and its changes are no longer pending. */
  | { phase: 'complete'; result: PromotionSyncResult };

export interface RecalculationResult {
  outcome: 'unchanged' | 'recalculated';
  /** The current roster — freshly scored, or the stored one when unchanged. */
  roster: TrustedArtistsFile;
  /** Every tier move this run, sorted by new tier then old. */
  changes: PriorityChange[];
  /** P1/P2 boundary crossings still awaiting promotion sync (all runs). */
  pending: PriorityChange[];
}

export interface RecalculateOptions {
  /** Re-score even when neither source changed (e.g. new thresholds). */
  force?: boolean;
  onProgress?: (e: RecalculationProgress) => void;
}

// ── Internals ────────────────────────────────────────────────────────────────

const isP1P2 = (p: number | null) => p === 1 || p === 2;

/** By new tier, then old; `null` (no tier) sorts last. */
function byTier(a: PriorityChange, b: PriorityChange): number {
  return (a.to ?? 99) - (b.to ?? 99) || (a.from ?? 99) - (b.from ?? 99);
}

/**
 * Per-artist counts and latest position over a source's items. Positions run
 * oldest to newest (higher is more recent) and count every slot; the track's
 * first artist is its primary one. `newestFirst` flips Liked Songs, which
 * Spotify lists newest first.
 */
export function scanPositions(
  items: PlaylistItem[],
  newestFirst = false,
): PlaylistScanResult {
  const artistData = new Map<string, PlaylistArtistData>();
  const total = items.length;
  items.forEach((item, position) => {
    if (!item.track) return;
    const logicalPosition = newestFirst ? total - 1 - position : position;
    item.track.artists.forEach((artist, index) => {
      const isFeatured = index !== 0;
      let data = artistData.get(artist.name);
      if (!data) {
        data = {
          primaryCount: 0,
          featuredCount: 0,
          latestPosition: -1,
          featuredAtLatest: false,
          id: artist.id,
        };
        artistData.set(artist.name, data);
      }
      if (isFeatured) data.featuredCount++;
      else data.primaryCount++;
      if (logicalPosition > data.latestPosition) {
        data.latestPosition = logicalPosition;
        data.featuredAtLatest = isFeatured;
      }
    });
  });
  return { artistData, totalTracks: total };
}

type SourceRead = Extract<PlaylistRead, { success: true }>;

/** Read one source through playlist reads; a failed read throws. */
async function readSource(
  source: Source,
  userConfig: UserConfig,
  playlists: PlaylistReads,
  onProgress: (e: RecalculationProgress) => void,
): Promise<SourceRead> {
  const name = sourceName(source, userConfig);
  const progress = (fetched: number, total: number) =>
    onProgress({ phase: 'scan-progress', source, name, fetched, total });
  const ids = userConfig.sourcePlaylists;
  const read = isLikedSongs(source, userConfig)
    ? await playlists.likedSongs({ onProgress: progress })
    : await playlists.tracks(
        source === 'aw' ? ids.allWeeklyId : ids.bestOfAllWeeklyId,
        { onProgress: progress },
      );
  onProgress({ phase: 'scan-read', source, name });
  if (!read.success) throw read.error;
  return read;
}

const sourceName = (source: Source, userConfig: UserConfig) =>
  source === 'aw' ? 'All Weekly' : secondarySourceName(userConfig);

const isLikedSongs = (source: Source, userConfig: UserConfig) =>
  source === 'boaw' && userConfig.sourcePlaylists.useLikedSongs;

/**
 * The snapshot to record as scored. A short read is scored but never
 * recorded, so the next recalculation reads and scores the source again
 * (ADR-0013), the way playlist reads never stores one.
 */
const scoredSnapshot = (read: SourceRead) =>
  read.missing > 0 ? undefined : read.snapshot;

function diffPriorities(
  prior: TrustedArtistsFile,
  roster: TrustedArtistsFile,
): PriorityChange[] {
  const changes: PriorityChange[] = [];
  for (const [artist, data] of Object.entries(roster.artistCounts)) {
    const from = prior.artistCounts[artist]?.priority ?? null;
    if (from !== data.priority)
      changes.push({ artist, from, to: data.priority });
  }
  for (const [artist, data] of Object.entries(prior.artistCounts)) {
    if (!(artist in roster.artistCounts) && data.priority !== null)
      changes.push({ artist, from: data.priority, to: null });
  }
  return changes.sort(byTier);
}

/**
 * Fold this run's changes into what's already pending. Per artist, the oldest
 * `from` (what the playlists were built with) meets the newest `to`; anything
 * that no longer crosses the P1/P2 boundary drops out.
 */
function mergePending(
  pending: PriorityChange[],
  changes: PriorityChange[],
): PriorityChange[] {
  const byArtist = new Map(pending.map((c) => [c.artist, c]));
  for (const c of changes) {
    const earlier = byArtist.get(c.artist);
    byArtist.set(c.artist, {
      artist: c.artist,
      from: earlier ? earlier.from : c.from,
      to: c.to,
    });
  }
  return [...byArtist.values()]
    .filter((c) => isP1P2(c.from) !== isP1P2(c.to))
    .sort(byTier);
}

function scanSource(
  source: Source,
  read: SourceRead,
  userConfig: UserConfig,
  onProgress: (e: RecalculationProgress) => void,
): PlaylistScanResult {
  const scan = scanPositions(read.items, isLikedSongs(source, userConfig));
  onProgress({
    phase: 'scan-done',
    source,
    name: sourceName(source, userConfig),
    artists: scan.artistData.size,
    tracks: scan.totalTracks,
    cached: read.cached,
    missing: read.missing,
  });
  return scan;
}

// ── Interface ────────────────────────────────────────────────────────────────

/**
 * Re-score the session user's roster if either source playlist changed (or
 * `force`), and record the resulting P1/P2 crossings as pending priority
 * changes. Their user data holds the config, the roster, recalculation state
 * and the pending changes. Never touches weekly playlists — see
 * `syncPending`. Tests, and a fill holding its own, pass `ports`.
 */
export async function recalculate(
  session: UserSession,
  opts: RecalculateOptions = {},
  ports: RecalculationPorts = spotifyRecalculationPorts(session),
): Promise<RecalculationResult> {
  const { data } = session;
  const userConfig = await data.config.load();
  const onProgress = opts.onProgress ?? (() => {});

  const [state, prior, pending] = await Promise.all([
    data.load(RECALCULATION_STATE).then((v) => v ?? {}),
    data.load(TRUSTED_ARTISTS),
    data.load(PENDING_PRIORITY_CHANGES),
  ]);
  // Both sources are read first: an unchanged one is held by playlist reads,
  // so this costs one snapshot call each. Changed means "not the snapshot
  // recalculation last scored", never just "not held" (ADR-0013).
  const aw = await readSource('aw', userConfig, ports.playlists, onProgress);
  const boaw = await readSource(
    'boaw',
    userConfig,
    ports.playlists,
    onProgress,
  );
  const changed =
    aw.snapshot !== state.allWeeklySnapshot ||
    boaw.snapshot !== state.bestOfAllWeeklySnapshot;

  if (prior && !(opts.force || changed)) {
    return {
      outcome: 'unchanged',
      roster: prior,
      changes: [],
      pending: pending ?? [],
    };
  }

  onProgress({ phase: 'recalculating' });
  const awScan = scanSource('aw', aw, userConfig, onProgress);
  const boawScan = scanSource('boaw', boaw, userConfig, onProgress);
  const roster = scoreRoster(awScan, boawScan, userConfig);

  // With no prior roster this is a baseline, not a set of crossings.
  const changes = prior ? diffPriorities(prior, roster) : [];
  const nextPending = mergePending(pending ?? [], changes);

  // Pending first: if we stop before the roster is saved, the next run
  // re-derives the same changes and the merge makes that idempotent.
  if (nextPending.length > 0)
    await data.save(PENDING_PRIORITY_CHANGES, nextPending);
  else await data.delete(PENDING_PRIORITY_CHANGES);
  await data.save(TRUSTED_ARTISTS, roster);
  await data.save(RECALCULATION_STATE, {
    allWeeklySnapshot: scoredSnapshot(aw),
    bestOfAllWeeklySnapshot: scoredSnapshot(boaw),
  });

  return { outcome: 'recalculated', roster, changes, pending: nextPending };
}

/**
 * Apply every pending priority change to the unprocessed weekly playlists via
 * promotion sync, then clear them. Returns null when nothing was pending.
 * Throws on failure with the changes still pending — safe to retry, since
 * promotion sync skips tracks already present or already removed.
 */
export async function syncPending(
  session: UserSession,
  onProgress: (e: SyncProgress) => void = () => {},
  ports: RecalculationPorts = spotifyRecalculationPorts(session),
): Promise<PromotionSyncResult | null> {
  const { data } = session;
  const userConfig = await data.config.load();
  const pending = await data.load(PENDING_PRIORITY_CHANGES);
  const roster = await data.load(TRUSTED_ARTISTS);
  if (!(pending && roster)) return null;

  const log = (message: string, level: 'info' | 'debug' = 'info') =>
    onProgress({ phase: 'log', message, level });
  const { playlists, awTrackIds } = await ports.unprocessed.find(
    userConfig.sourcePlaylists.allWeeklyId,
    log,
  );
  if (playlists.length === 0) {
    // Every later weekly playlist is built from the new roster anyway.
    log('No unprocessed weekly playlists found');
    await data.delete(PENDING_PRIORITY_CHANGES);
    return null;
  }

  const result = await syncPriorityChanges(
    pending,
    {
      unprocessedPlaylists: playlists,
      awTrackIds,
      trustedArtists: roster,
      // Newly-promoted artists backfill their whole recent back-catalogue, so
      // hold them to a higher bar than the weekly gate — twice the configured
      // minimum — to keep stale low-popularity releases out.
      minPopularity: userConfig.editorialFilter.minPopularity * 2,
    },
    ports.sync,
    onProgress,
  );

  await data.delete(PENDING_PRIORITY_CHANGES);
  onProgress({ phase: 'complete', result });
  return result;
}
