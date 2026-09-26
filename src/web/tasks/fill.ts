import { fillPorts } from '../../services/playlist-filler/adapters.js';
import { runFill } from '../../services/playlist-filler/fill-run.js';
import { DurableFillStorage } from '../../services/playlist-filler/storage.js';
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

    const handlers = broadcastHandlers(tc.broadcast, {
      searchedArtists,
      checkAbort: tc.checkAbort,
    });

    const storage = new DurableFillStorage(tc.cache, tc.dataDir);
    await runFill({
      ctx: tc.ctx,
      userId: tc.userId,
      userConfig,
      storage,
      cache: tc.cache,
      ports: fillPorts(tc.ctx, {
        userId: tc.userId,
        dataDir: tc.dataDir,
        storage,
      }),
      handlers,
      syncHandlers: broadcastSyncHandlers(tc.broadcast),
      fresh: freshMode,
    });
  },

  onError(tc, error, aborted) {
    if (aborted) tc.emit('fill:stopped', {});
    else tc.emit('fill:error', { date: 'batch', message: String(error) });
  },

  // The unprocessed-playlists listing is invalidated by the Weekly playlists
  // module before each write, so nothing is left to drop here.
  async cleanup() {
    searchedArtists.clear();
  },
};
