import {
  BATCH_CACHE,
  PENDING_PRIORITY_CHANGES,
  RECALCULATION_STATE,
  TRUSTED_ARTISTS,
} from '../../lib/cache-files.js';
import type { DurableCache } from '../../lib/durable-cache.js';
import {
  type CachedScanResult,
  type PlaylistScanResult,
  type RecalculationState,
  type SimplePlaylist,
  type TrustedArtistsFile,
  isRoleTaggedCache,
  toCachedScanResult,
  toScanResult,
} from '../../lib/types.js';
import { type UserConfig, secondarySourceName } from '../../lib/user-config.js';
import {
  type PriorityChange,
  type PromotionProgressEvent,
  type PromotionSyncPorts,
  type PromotionSyncResult,
  syncPriorityChanges,
} from '../promotion-sync/index.js';
import { scoreRoster } from './score.js';

/**
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

/** The two source playlists (BoAW may be Liked Songs, per `useLikedSongs`). */
export interface SourceReads {
  snapshots(sources: SourcePlaylists): Promise<SourceSnapshots>;
  scan(
    source: Source,
    sources: SourcePlaylists,
    onProgress: (fetched: number, total: number) => void,
  ): Promise<PlaylistScanResult>;
}

/** The unprocessed (non-listened) weekly playlists promotion sync reconciles. */
export interface UnprocessedPlaylists {
  find(
    allWeeklyId: string,
    log: (message: string, level?: 'info' | 'debug') => void,
  ): Promise<{ playlists: SimplePlaylist[]; awTrackIds: Set<string> }>;
  /** Drop any cached listing; called after a sync changed the playlists. */
  invalidate(): Promise<void>;
}

export interface RecalculationPorts {
  sources: SourceReads;
  unprocessed: UnprocessedPlaylists;
  sync: PromotionSyncPorts;
}

export interface RecalculationDeps {
  /** Holds the roster, recalculation state and pending priority changes. */
  cache: DurableCache;
  ports: RecalculationPorts;
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
  | { phase: 'log'; message: string; level: 'info' | 'debug' };

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
 * Recalculation's own state, falling back to the fields older versions kept
 * in the batch cache. `migrated` tells the caller to write the state under
 * its own descriptor, after which the fallback is never hit again.
 */
async function loadState(
  cache: DurableCache,
): Promise<{ state: RecalculationState; migrated: boolean }> {
  const own = await cache.load(RECALCULATION_STATE);
  if (own) return { state: own, migrated: false };
  const legacy = await cache.load(BATCH_CACHE);
  if (!legacy?.allWeeklySnapshot) return { state: {}, migrated: false };
  const { artistSearchProgress: _, ...state } = legacy;
  return { state, migrated: true };
}

interface SourcePlan {
  /** What to record: the live snapshot, or the stored one if Spotify couldn't say. */
  snapshot?: string;
  /** Scan reusable as-is: its snapshot is known and unchanged. */
  reusable?: PlaylistScanResult;
  changed: boolean;
}

/**
 * A source counts as changed unless its stored snapshot is known and matches
 * (a cold cache is "changed"). If Spotify couldn't report a live snapshot, the
 * stored one stands — a transient read failure never forces a full re-scan.
 */
function planSource(
  stored: string | undefined,
  live: string | undefined,
  scanCache: CachedScanResult | undefined,
): SourcePlan {
  const changed = !stored || (live !== undefined && live !== stored);
  const reusable =
    !changed && scanCache && isRoleTaggedCache(scanCache)
      ? toScanResult(scanCache)
      : undefined;
  return { snapshot: live ?? stored, reusable, changed };
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
  plan: SourcePlan,
  userConfig: UserConfig,
  reads: SourceReads,
  onProgress: (e: RecalculationProgress) => void,
): Promise<PlaylistScanResult> {
  const name = source === 'aw' ? 'All Weekly' : secondarySourceName(userConfig);
  let scan = plan.reusable;
  if (!scan) {
    onProgress({ phase: 'scan-start', source, name });
    scan = await reads.scan(
      source,
      userConfig.sourcePlaylists,
      (fetched, total) =>
        onProgress({ phase: 'scan-progress', source, name, fetched, total }),
    );
  }
  onProgress({
    phase: 'scan-done',
    source,
    name,
    artists: scan.artistData.size,
    tracks: scan.totalTracks,
    cached: !!plan.reusable,
  });
  return scan;
}

// ── Interface ────────────────────────────────────────────────────────────────

/**
 * Re-score the roster if either source playlist changed (or `force`), and
 * record the resulting P1/P2 crossings as pending priority changes. Never
 * touches weekly playlists — see `syncPending`.
 */
export async function recalculate(
  userConfig: UserConfig,
  deps: RecalculationDeps,
  opts: RecalculateOptions = {},
): Promise<RecalculationResult> {
  const { cache, ports } = deps;
  const onProgress = opts.onProgress ?? (() => {});

  const [{ state, migrated }, prior, pending, live] = await Promise.all([
    loadState(cache),
    cache.load(TRUSTED_ARTISTS),
    cache.load(PENDING_PRIORITY_CHANGES),
    ports.sources.snapshots(userConfig.sourcePlaylists),
  ]);
  const aw = planSource(state.allWeeklySnapshot, live.aw, state.awScanCache);
  const boaw = planSource(
    state.bestOfAllWeeklySnapshot,
    live.boaw,
    state.boawScanCache,
  );

  if (prior && !(opts.force || aw.changed || boaw.changed)) {
    if (migrated) await cache.save(RECALCULATION_STATE, state);
    return {
      outcome: 'unchanged',
      roster: prior,
      changes: [],
      pending: pending ?? [],
    };
  }

  onProgress({ phase: 'recalculating' });
  const awScan = await scanSource(
    'aw',
    aw,
    userConfig,
    ports.sources,
    onProgress,
  );
  const boawScan = await scanSource(
    'boaw',
    boaw,
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
    await cache.save(PENDING_PRIORITY_CHANGES, nextPending);
  else await cache.delete(PENDING_PRIORITY_CHANGES);
  await cache.save(TRUSTED_ARTISTS, roster);
  await cache.save(RECALCULATION_STATE, {
    allWeeklySnapshot: aw.snapshot,
    bestOfAllWeeklySnapshot: boaw.snapshot,
    awScanCache: toCachedScanResult(awScan),
    boawScanCache: toCachedScanResult(boawScan),
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
  userConfig: UserConfig,
  deps: RecalculationDeps,
  onProgress: (e: SyncProgress) => void = () => {},
): Promise<PromotionSyncResult | null> {
  const { cache, ports } = deps;
  const pending = await cache.load(PENDING_PRIORITY_CHANGES);
  const roster = await cache.load(TRUSTED_ARTISTS);
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
    await cache.delete(PENDING_PRIORITY_CHANGES);
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

  await cache.delete(PENDING_PRIORITY_CHANGES);
  if (result.removed > 0 || result.added > 0)
    await ports.unprocessed.invalidate();
  return result;
}
