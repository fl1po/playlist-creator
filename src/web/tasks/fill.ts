import { invalidateNonListenedCache } from '../../services/non-listened-playlists.js';
import { runFill } from '../../services/playlist-filler/fill-run.js';
import { RedisAndClientStorage } from '../../services/playlist-filler/storage.js';
import {
  broadcastApiCallbacks,
  broadcastHandlers,
} from '../../services/playlist-filler/subscribers.js';
import { broadcastSyncHandlers } from '../../services/promotion-sync/subscribers.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

interface FillEvents extends BaseEvents {
  'fill:stopped': Record<string, never>;
  'fill:error': { date: string; message: string };
  // fill:start / fill:progress / fill:searchProgress / fill:releaseFound /
  // fill:dateComplete / fill:recalculated / fill:complete /
  // fill:searchedArtists / fill:rateLimited are emitted through
  // broadcastHandlers / broadcastApiCallbacks using the raw tc.broadcast
  // interop surface.
}

const searchedArtists = new Set<string>();
export const getSearchedArtists = (): ReadonlySet<string> => searchedArtists;

export const fillTask: TaskDefinition<FillEvents> = {
  name: 'fill',
  path: '/fill',
  startMessage: 'Fill started',
  apiCallbacks: (b) => broadcastApiCallbacks(b),

  async run(tc: TaskContext<FillEvents>) {
    const freshMode = !!tc.body.fresh;
    searchedArtists.clear();
    tc.log('info', `Starting playlist fill (fresh=${freshMode})...`);

    const userConfig = await tc.userConfig();

    const storage = new RedisAndClientStorage(
      tc.dataDir,
      tc.userId,
      tc.emitData,
    );

    const handlers = broadcastHandlers(tc.broadcast, {
      searchedArtists,
      checkAbort: tc.checkAbort,
    });

    const config = {
      freshMode,
      allWeeklyId: userConfig.sourcePlaylists.allWeeklyId,
      bestOfAllWeeklyId: userConfig.sourcePlaylists.bestOfAllWeeklyId,
      useLikedSongs: userConfig.sourcePlaylists.useLikedSongs,
      editorialPlaylists: userConfig.editorialPlaylists,
      externalPlaylistSources: userConfig.externalPlaylistSources,
      genreFilters: userConfig.genreFilters,
      editorialFilter: userConfig.editorialFilter,
      scoring: userConfig.scoring,
    };

    const result = await runFill({
      ctx: tc.ctx,
      config,
      storage,
      handlers,
      syncHandlers: broadcastSyncHandlers(tc.broadcast),
      fresh: freshMode,
    });

    // Surface the per-artist priority changes the same way recalc does, so a
    // fill also shows who was promoted/demoted — not just the sync counts.
    if (result.priorityChanges.length > 0) {
      const changes = [...result.priorityChanges].sort(
        (a, b) =>
          (a.to ?? 99) - (b.to ?? 99) || (a.from ?? 99) - (b.from ?? 99),
      );
      tc.broadcast('recalc:changes', { changes });
    }
  },

  onError(tc, error, aborted) {
    if (aborted) tc.emit('fill:stopped', {});
    else tc.emit('fill:error', { date: 'batch', message: String(error) });
  },

  cleanup(tc) {
    searchedArtists.clear();
    invalidateNonListenedCache(tc.dataDir, tc.userId);
  },
};
