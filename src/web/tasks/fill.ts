import { invalidateNonListenedCache } from '../../services/non-listened-playlists.js';
import {
  BroadcastPresenter,
  RedisAndClientStorage,
  runWebFill,
} from '../../services/playlist-filler/index.js';
import type { TaskContext, TaskDefinition } from '../task-runner.js';

const searchedArtists = new Set<string>();
export const getSearchedArtists = (): ReadonlySet<string> => searchedArtists;

export const fillTask: TaskDefinition = {
  name: 'fill',
  path: '/fill',
  startMessage: 'Fill started',
  apiCallbacks: (b) => BroadcastPresenter.apiCallbacks(b),

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

    const presenter = new BroadcastPresenter(tc.broadcast, {
      searchedArtists,
      checkAbort: tc.checkAbort,
    });

    await runWebFill({
      ctx: tc.ctx,
      config: {
        freshMode,
        allWeeklyId: userConfig.sourcePlaylists.allWeeklyId,
        bestOfAllWeeklyId: userConfig.sourcePlaylists.bestOfAllWeeklyId,
        useLikedSongs: userConfig.sourcePlaylists.useLikedSongs,
        editorialPlaylists: userConfig.editorialPlaylists,
        externalPlaylistSources: userConfig.externalPlaylistSources,
        genreFilters: userConfig.genreFilters,
        editorialFilter: userConfig.editorialFilter,
      },
      storage,
      presenter,
      fresh: freshMode,
      userId: tc.userId,
      rawClient: tc.rawClient,
      pacer: tc.pacer,
      dataDir: tc.dataDir,
      broadcast: tc.broadcast,
    });
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
