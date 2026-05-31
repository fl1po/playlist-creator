import fs from 'node:fs';
import type { PriorityThresholds, ScoringWeights } from '../domain/artists.js';
import type { EventHandlers } from '../lib/service-events.js';
import type { SpotifyContext } from '../lib/spotify-context.js';
import {
  type BatchCache,
  type PlaylistScanResult,
  type TrustedArtistsFile,
  toScanResult,
} from '../lib/types.js';
import type { PriorityChange } from './playlist-syncer.js';
import {
  type PriorityCalculatorEventMap,
  PriorityCalculatorService,
} from './priority-calculator.js';

export type { PriorityChange } from './playlist-syncer.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SourcePlaylists {
  allWeeklyId: string;
  bestOfAllWeeklyId: string;
  useLikedSongs: boolean;
}

export interface SourceSnapshots {
  aw?: string;
  boaw?: string;
}

export interface SnapshotDelta {
  awChanged: boolean;
  boawChanged: boolean;
  anyChanged: boolean;
}

export interface RecalcOptions {
  ctx: SpotifyContext;
  sources: SourcePlaylists;
  scoring?: { weights?: ScoringWeights; thresholds?: PriorityThresholds };
  preloaded?: { aw?: PlaylistScanResult; boaw?: PlaylistScanResult };
  events?: EventHandlers<PriorityCalculatorEventMap>;
  /** When given, compute a tier diff against this prior snapshot. */
  prior?: Map<string, number | null>;
}

export interface RecalcResult {
  trustedArtists: TrustedArtistsFile;
  scanResults: { aw: PlaylistScanResult; boaw: PlaylistScanResult };
  /** Present iff opts.prior was given. */
  tierChanges?: PriorityChange[];
}

// ── Snapshot lifecycle ──────────────────────────────────────────────────────

/** Fetch live snapshot ids for the two source playlists (or Liked Songs). */
export async function fetchSourceSnapshots(
  ctx: SpotifyContext,
  sources: SourcePlaylists,
): Promise<SourceSnapshots> {
  const awResult = await ctx.call(
    () =>
      ctx.api.playlists.getPlaylist(
        sources.allWeeklyId,
        undefined,
        'snapshot_id',
      ),
    'All Weekly snapshot',
  );
  const aw = awResult.success ? awResult.data.snapshot_id : undefined;

  let boaw: string | undefined;
  if (sources.useLikedSongs) {
    const likedResult = await ctx.call(
      () => ctx.api.currentUser.tracks.savedTracks(1, 0),
      'Liked Songs snapshot',
    );
    if (likedResult.success) {
      const data = likedResult.data as {
        total?: number;
        items?: Array<{ added_at?: string }>;
      };
      boaw = `${data.total ?? 0}:${data.items?.[0]?.added_at ?? ''}`;
    }
  } else {
    const boawResult = await ctx.call(
      () =>
        ctx.api.playlists.getPlaylist(
          sources.bestOfAllWeeklyId,
          undefined,
          'snapshot_id',
        ),
      'Best of All Weekly snapshot',
    );
    boaw = boawResult.success ? boawResult.data.snapshot_id : undefined;
  }

  return { aw, boaw };
}

/**
 * Compare cached snapshots (stored on `BatchCache`) against live ones.
 *
 * A source is considered "changed" only when a cached value exists and differs
 * from the live one — first-run (no cached value) counts as unchanged so the
 * caller can decide whether to scan or initialise.
 */
export function diffSnapshots(
  cache: Pick<BatchCache, 'allWeeklySnapshot' | 'bestOfAllWeeklySnapshot'>,
  live: SourceSnapshots,
): SnapshotDelta {
  const awChanged = !!(
    cache.allWeeklySnapshot &&
    live.aw &&
    cache.allWeeklySnapshot !== live.aw
  );
  const boawChanged = !!(
    cache.bestOfAllWeeklySnapshot &&
    live.boaw &&
    cache.bestOfAllWeeklySnapshot !== live.boaw
  );
  return { awChanged, boawChanged, anyChanged: awChanged || boawChanged };
}

/** Pick scan caches the calculator can reuse for sources that didn't change. */
export function pickReusableScans(
  cache: BatchCache,
  delta: SnapshotDelta,
): { aw?: PlaylistScanResult; boaw?: PlaylistScanResult } {
  const preloaded: { aw?: PlaylistScanResult; boaw?: PlaylistScanResult } = {};
  if (!delta.awChanged && cache.awScanCache) {
    preloaded.aw = toScanResult(cache.awScanCache);
  }
  if (!delta.boawChanged && cache.boawScanCache) {
    preloaded.boaw = toScanResult(cache.boawScanCache);
  }
  return preloaded;
}

// ── Priority snapshot + diff (over the trusted-artists file) ────────────────

/** Snapshot artist → priority from a trusted-artists.json on disk. */
export function snapshotPriorities(
  trustedPath: string,
): Map<string, number | null> {
  const priorities = new Map<string, number | null>();
  try {
    const prev = JSON.parse(
      fs.readFileSync(trustedPath, 'utf-8'),
    ) as TrustedArtistsFile;
    for (const [name, data] of Object.entries(prev.artistCounts))
      priorities.set(name, data.priority);
  } catch {
    /* first run or missing file */
  }
  return priorities;
}

/** Snapshot artist → priority from an in-memory trusted-artists value. */
export function snapshotPrioritiesFrom(
  trusted: TrustedArtistsFile | null | undefined,
): Map<string, number | null> {
  const priorities = new Map<string, number | null>();
  if (!trusted) return priorities;
  for (const [name, data] of Object.entries(trusted.artistCounts))
    priorities.set(name, data.priority);
  return priorities;
}

/** Compare a priority snapshot to the current trusted-artists file. */
export function diffPriorities(
  old: Map<string, number | null>,
  current: TrustedArtistsFile,
): PriorityChange[] {
  const changes: PriorityChange[] = [];
  for (const [name, data] of Object.entries(current.artistCounts)) {
    const prev = old.get(name) ?? null;
    if (prev !== data.priority)
      changes.push({ artist: name, from: prev, to: data.priority });
  }
  for (const [name, prev] of old) {
    if (!(name in current.artistCounts))
      changes.push({ artist: name, from: prev, to: null });
  }
  return changes;
}

// ── Recalculate ─────────────────────────────────────────────────────────────

/**
 * Run the priority calculator and optionally compute a tier diff.
 *
 * Owns no persistence and no broadcasting — caller decides where the result
 * goes. Pass `preloaded` to skip scanning sources that haven't changed
 * (see `pickReusableScans`). Pass `prior` to populate `result.tierChanges`.
 */
export async function recalculate(opts: RecalcOptions): Promise<RecalcResult> {
  const service = new PriorityCalculatorService(
    opts.ctx,
    {
      allWeeklyId: opts.sources.allWeeklyId,
      bestOfAllWeeklyId: opts.sources.bestOfAllWeeklyId,
      useLikedSongs: opts.sources.useLikedSongs,
      scoringWeights: opts.scoring?.weights,
      priorityThresholds: opts.scoring?.thresholds,
      preloaded: opts.preloaded,
    },
    opts.events,
  );

  const { scanResults, ...trustedArtists } = await service.run();

  const result: RecalcResult = { trustedArtists, scanResults };
  if (opts.prior) {
    result.tierChanges = diffPriorities(opts.prior, trustedArtists);
  }
  return result;
}
