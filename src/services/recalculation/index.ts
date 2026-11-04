import type {
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

export type SourcePlaylists = UserConfig['sourcePlaylists'];

/** Live snapshot ids; `undefined` when Spotify couldn't say. */
export interface SourceSnapshots {
  aw?: string;
  boaw?: string;
}

/** A source's scan; `cached` when its tracks came without fetching a page. */
export interface SourceScan extends PlaylistScanResult {
  cached: boolean;
}

/**
 * The two source playlists (BoAW may be Liked Songs, per `useLikedSongs`).
 * `snapshots` decides whether to re-score at all; `scan` reads a source's
 * tracks through playlist reads (ADR-0011), so an unchanged source is cheap.
 */
export interface SourceReads {
  snapshots(sources: SourcePlaylists): Promise<SourceSnapshots>;
  scan(
    source: Source,
    sources: SourcePlaylists,
    onProgress: (fetched: number, total: number) => void,
  ): Promise<SourceScan>;
}

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

export interface RecalculationPorts {
  sources: SourceReads;
  unprocessed: UnprocessedPlaylists;
  sync: PromotionSyncPorts;
}

// ── Progress + results ───────────────────────────────────────────────────────

/** Liveness only — results come back as data. */
export type RecalculationProgress =
  | { phase: 'recalculating' }
  | { phase: 'scan-start'; source: Source; name: string }
  | {
      phase: 'scan-progress';
      source: Source;
      name: string;
      fetched: number;
      total: number;
    }
  | {
      phase: 'scan-done';
      source: Source;
      name: string;
      artists: number;
      tracks: number;
      cached: boolean;
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
 * A source counts as changed unless its stored snapshot is known and matches
 * the live one. A cold state, or a live snapshot Spotify couldn't report,
 * counts as changed: re-scoring is cheap once playlist reads hold the tracks.
 */
function sourceChanged(stored: string | undefined, live: string | undefined) {
  return !(stored && live) || live !== stored;
}

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

async function scanSource(
  source: Source,
  userConfig: UserConfig,
  reads: SourceReads,
  onProgress: (e: RecalculationProgress) => void,
): Promise<PlaylistScanResult> {
  const name = source === 'aw' ? 'All Weekly' : secondarySourceName(userConfig);
  onProgress({ phase: 'scan-start', source, name });
  const scan = await reads.scan(
    source,
    userConfig.sourcePlaylists,
    (fetched, total) =>
      onProgress({ phase: 'scan-progress', source, name, fetched, total }),
  );
  onProgress({
    phase: 'scan-done',
    source,
    name,
    artists: scan.artistData.size,
    tracks: scan.totalTracks,
    cached: scan.cached,
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

  const [state, prior, pending, live] = await Promise.all([
    data.load(RECALCULATION_STATE).then((v) => v ?? {}),
    data.load(TRUSTED_ARTISTS),
    data.load(PENDING_PRIORITY_CHANGES),
    ports.sources.snapshots(userConfig.sourcePlaylists),
  ]);
  const changed =
    sourceChanged(state.allWeeklySnapshot, live.aw) ||
    sourceChanged(state.bestOfAllWeeklySnapshot, live.boaw);

  if (prior && !(opts.force || changed)) {
    return {
      outcome: 'unchanged',
      roster: prior,
      changes: [],
      pending: pending ?? [],
    };
  }

  onProgress({ phase: 'recalculating' });
  const awScan = await scanSource('aw', userConfig, ports.sources, onProgress);
  const boawScan = await scanSource(
    'boaw',
    userConfig,
    ports.sources,
    onProgress,
  );
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
    allWeeklySnapshot: live.aw,
    bestOfAllWeeklySnapshot: live.boaw,
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
