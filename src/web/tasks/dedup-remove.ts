import { invalidateNonListenedCache } from '../../lib/pagination.js';
import type { TaskContext, TaskDefinition } from '../task-runner.js';

export const dedupRemoveTask: TaskDefinition = {
  name: 'dedup-remove',
  path: '/dedup-remove',
  startMessage: 'Dedup removal started',

  validate(body) {
    const playlists = body.playlists;
    if (
      !(playlists && Array.isArray(playlists)) ||
      playlists.length === 0
    ) {
      return 'playlists array is required';
    }
    return undefined;
  },

  async run(tc: TaskContext) {
    const playlists = tc.body.playlists as Array<{
      id: string;
      uris: string[];
    }>;
    let totalRemoved = 0;

    for (const pl of playlists) {
      tc.checkAbort();
      const batchSize = 100;
      for (let i = 0; i < pl.uris.length; i += batchSize) {
        tc.checkAbort();
        const batch = pl.uris.slice(i, i + batchSize);
        await tc.client.api.playlists.removeItemsFromPlaylist(pl.id, {
          tracks: batch.map((uri) => ({ uri })),
        });
        totalRemoved += batch.length;
      }
    }

    tc.broadcast('dedup:complete', { totalRemoved });
    tc.broadcast('log', {
      level: 'success',
      message: `Removed ${totalRemoved} duplicate tracks`,
    });
  },

  cleanup(tc: TaskContext) {
    invalidateNonListenedCache(tc.dataDir);
  },
};
