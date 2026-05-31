import { invalidateNonListenedCache } from '../../services/non-listened-playlists.js';
import { runFill } from '../../services/playlist-filler/fill-run.js';
import {
  computePriorityChanges,
  maybeAppendFillHistory,
  writeProgressFile,
} from '../../services/playlist-filler/post.js';
import { RedisAndClientStorage } from '../../services/playlist-filler/storage.js';
import {
  broadcastApiCallbacks,
  broadcastHandlers,
} from '../../services/playlist-filler/subscribers.js';
import { syncIfNeeded } from '../priority-diff.js';
import type { TaskContext, TaskDefinition } from '../task-runner.js';

const searchedArtists = new Set<string>();
export const getSearchedArtists = (): ReadonlySet<string> => searchedArtists;

export const fillTask: TaskDefinition = {
  name: 'fill',
  path: '/fill',
  startMessage: 'Fill started',
  apiCallbacks: (b) => broadcastApiCallbacks(b),

  async run(tc: TaskContext) {
    const freshMode = !!tc.body.fresh;
    searchedArtists.clear();
    tc.broadcast('log', {
      level: 'info',
      message: `Starting playlist fill (fresh=${freshMode})...`,
    });

    const userConfig = await tc.userConfigStore.load();

    const storage = new RedisAndClientStorage(
      tc.dataDir,
      tc.userId,
      {
        trustedArtists: tc.caches.trustedArtists,
        batchCache: tc.caches.batchCache,
        fillHistory: tc.caches.fillHistory,
      },
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
    };

    const result = await runFill({
      ctx: tc.ctx,
      config,
      storage,
      handlers,
      fresh: freshMode,
    });

    // Post-fill: progress file, history, then sync if P1/P2 boundary crossed.
    await writeProgressFile(storage, result);
    await maybeAppendFillHistory(storage, result);

    const changes = computePriorityChanges(
      result.prioritiesBefore,
      result.prioritiesAfter,
    );
    try {
      await syncIfNeeded(
        changes,
        tc.rawClient,
        tc.dataDir,
        config.allWeeklyId ?? '',
        tc.pacer,
        tc.broadcast,
      );
    } catch (syncErr) {
      tc.broadcast('log', {
        level: 'warn',
        message: `Post-fill sync failed: ${syncErr}`,
      });
    }
  },

  onError(tc: TaskContext, error: unknown, aborted: boolean) {
    if (aborted) tc.broadcast('fill:stopped', {});
    else tc.broadcast('fill:error', { date: 'batch', message: String(error) });
  },

  cleanup(tc: TaskContext) {
    searchedArtists.clear();
    invalidateNonListenedCache(tc.dataDir);
  },
};
