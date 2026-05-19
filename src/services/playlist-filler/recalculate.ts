import type { ServiceEmitter } from '../../lib/service-events.js';
import type { SpotifyContext } from '../../lib/spotify-context.js';
import type { BatchCache, CachedScanResult, PlaylistArtistData, PlaylistScanResult } from '../../lib/types.js';
import { PriorityCalculatorService } from '../priority-calculator.js';
import type { PlaylistFillerEventMap } from './events.js';
import type { FillStorage } from './storage.js';

export interface RecalculateDeps {
  ctx: SpotifyContext;
  storage: FillStorage;
  emitter: ServiceEmitter<PlaylistFillerEventMap>;
  allWeeklyId: string;
  bestOfAllWeeklyId: string;
  useLikedSongs: boolean;
}

function toMap(record: Record<string, PlaylistArtistData>): Map<string, PlaylistArtistData> {
  return new Map(Object.entries(record));
}

function toRecord(map: Map<string, PlaylistArtistData>): Record<string, PlaylistArtistData> {
  return Object.fromEntries(map);
}

function toScanResult(cached: CachedScanResult): PlaylistScanResult {
  return { artistData: toMap(cached.artistData), totalTracks: cached.totalTracks };
}

function toCachedScanResult(scan: PlaylistScanResult): CachedScanResult {
  return { artistData: toRecord(scan.artistData), totalTracks: scan.totalTracks };
}

/**
 * Check whether the source playlists changed since the last cached snapshot.
 * If so, re-run the priority calculator — only scanning the source(s) that
 * actually changed, reusing cached scan data for the unchanged one.
 *
 * Returns true when a recalculation happened (caller should reload trusted
 * artists). Updates `cache.allWeeklySnapshot` / `bestOfAllWeeklySnapshot` and
 * persists the cache via storage.
 */
export async function maybeRecalculate(
  deps: RecalculateDeps,
  cache: BatchCache,
  targetDate: string,
): Promise<boolean> {
  const { ctx, storage, emitter } = deps;

  const awResult = await ctx.call(
    () => ctx.api.playlists.getPlaylist(deps.allWeeklyId),
    'All Weekly info',
  );
  if (!awResult.success) return false;
  const awSnapshot = awResult.data.snapshot_id;

  let boawSnapshot: string;
  if (deps.useLikedSongs) {
    const likedResult = await ctx.call(
      () => ctx.api.currentUser.tracks.savedTracks(1, 0),
      'Liked Songs snapshot',
    );
    if (likedResult.success) {
      const data = likedResult.data as {
        total?: number;
        items?: Array<{ added_at?: string }>;
      };
      const total = data.total ?? 0;
      const addedAt = data.items?.[0]?.added_at ?? '';
      boawSnapshot = `${total}:${addedAt}`;
    } else {
      boawSnapshot = cache.bestOfAllWeeklySnapshot ?? '0';
    }
  } else {
    const boawResult = await ctx.call(
      () => ctx.api.playlists.getPlaylist(deps.bestOfAllWeeklyId),
      'Best of All Weekly info',
    );
    if (!boawResult.success) return false;
    boawSnapshot = boawResult.data.snapshot_id;
  }

  const awChanged =
    cache.allWeeklySnapshot && cache.allWeeklySnapshot !== awSnapshot;
  const boawChanged =
    cache.bestOfAllWeeklySnapshot &&
    cache.bestOfAllWeeklySnapshot !== boawSnapshot;

  let recalculated = false;
  if (!(awChanged || boawChanged)) {
    emitter.emit('log', 'Snapshots unchanged — skipping recalculation');
  }
  if (awChanged || boawChanged) {
    const progress = cache.artistSearchProgress;
    const midSearch =
      progress && progress.date === targetDate && progress.artistsSearched > 0;
    if (!midSearch) {
      emitter.emit('recalculating');

      // Reuse cached scan data for the source that didn't change
      const preloaded: { aw?: PlaylistScanResult; boaw?: PlaylistScanResult } = {};
      if (!awChanged && cache.awScanCache) {
        preloaded.aw = toScanResult(cache.awScanCache);
      }
      if (!boawChanged && cache.boawScanCache) {
        preloaded.boaw = toScanResult(cache.boawScanCache);
      }

      const calcService = new PriorityCalculatorService(ctx, {
        allWeeklyId: deps.allWeeklyId,
        bestOfAllWeeklyId: deps.bestOfAllWeeklyId,
        useLikedSongs: deps.useLikedSongs,
        preloaded,
      });
      const { scanResults, ...trustedArtists } = await calcService.run();
      await storage.saveTrustedArtists(trustedArtists);

      // Cache scan results for next time
      cache.awScanCache = toCachedScanResult(scanResults.aw);
      cache.boawScanCache = toCachedScanResult(scanResults.boaw);

      emitter.emit('recalculated');
      recalculated = true;
    }
  }

  cache.allWeeklySnapshot = awSnapshot;
  cache.bestOfAllWeeklySnapshot = boawSnapshot;
  await storage.saveBatchCache(cache);
  return recalculated;
}
