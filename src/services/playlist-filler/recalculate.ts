import type { ServiceEmitter } from '../../lib/service-events.js';
import type { SpotifyContext } from '../../lib/spotify-context.js';
import type { BatchCache } from '../../lib/types.js';
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

/**
 * Check whether the source playlists changed since the last cached snapshot.
 * If so, re-run the priority calculator and save trusted-artists.
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
      const calcService = new PriorityCalculatorService(ctx, {
        allWeeklyId: deps.allWeeklyId,
        bestOfAllWeeklyId: deps.bestOfAllWeeklyId,
        useLikedSongs: deps.useLikedSongs,
      });
      const output = await calcService.run();
      await storage.saveTrustedArtists(output);
      emitter.emit('recalculated');
      recalculated = true;
    }
  }

  cache.allWeeklySnapshot = awSnapshot;
  cache.bestOfAllWeeklySnapshot = boawSnapshot;
  await storage.saveBatchCache(cache);
  return recalculated;
}
