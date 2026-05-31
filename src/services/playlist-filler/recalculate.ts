import type { ServiceEmitter } from '../../lib/service-events.js';
import type { SpotifyContext } from '../../lib/spotify-context.js';
import { type BatchCache, toCachedScanResult } from '../../lib/types.js';
import {
  type SourcePlaylists,
  diffSnapshots,
  fetchSourceSnapshots,
  pickReusableScans,
  recalculate,
  snapshotPrioritiesFrom,
} from '../recalculate.js';
import type { PlaylistFillerEventMap } from './events.js';
import type { FillStorage } from './storage.js';

export interface RecalculateDeps {
  ctx: SpotifyContext;
  storage: FillStorage;
  emitter: ServiceEmitter<PlaylistFillerEventMap>;
  sources: SourcePlaylists;
}

/**
 * Mid-Fill recalc: if either source playlist's snapshot has changed since the
 * cached one, re-run the priority calculator. Skipped when the current date is
 * mid-search so an in-flight artist scan isn't invalidated.
 *
 * Returns true when a recalc happened (caller should reload trusted artists).
 * Always updates `cache.{aw,boaw}Snapshot` and persists the cache.
 */
export async function maybeRecalculate(
  deps: RecalculateDeps,
  cache: BatchCache,
  targetDate: string,
): Promise<boolean> {
  const { ctx, storage, emitter, sources } = deps;

  const live = await fetchSourceSnapshots(ctx, sources);
  const delta = diffSnapshots(cache, live);

  const persistSnapshots = async () => {
    cache.allWeeklySnapshot = live.aw;
    cache.bestOfAllWeeklySnapshot = live.boaw;
    await storage.saveBatchCache(cache);
  };

  if (!delta.anyChanged) {
    emitter.emit('log', 'Snapshots unchanged — skipping recalculation');
    await persistSnapshots();
    return false;
  }

  const progress = cache.artistSearchProgress;
  const midSearch =
    progress && progress.date === targetDate && progress.artistsSearched > 0;
  if (midSearch) {
    await persistSnapshots();
    return false;
  }

  emitter.emit('recalculating');
  const prior = snapshotPrioritiesFrom(await storage.loadTrustedArtists());
  const result = await recalculate({
    ctx,
    sources,
    preloaded: pickReusableScans(cache, delta),
    prior,
  });

  await storage.saveTrustedArtists(result.trustedArtists);
  cache.awScanCache = toCachedScanResult(result.scanResults.aw);
  cache.boawScanCache = toCachedScanResult(result.scanResults.boaw);
  await persistSnapshots();

  emitter.emit('recalculated', result.tierChanges ?? []);
  return true;
}
