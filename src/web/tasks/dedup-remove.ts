import { invalidateNonListenedCache } from '../../services/non-listened-playlists.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

interface DedupRemoveEvents extends BaseEvents {
  'dedup:complete': { totalRemoved: number };
}

export const dedupRemoveTask: TaskDefinition<DedupRemoveEvents> = {
  name: 'dedup-remove',
  path: '/dedup-remove',
  startMessage: 'Dedup removal started',

  validate(body) {
    const playlists = body.playlists;
    if (!(playlists && Array.isArray(playlists)) || playlists.length === 0) {
      return 'playlists array is required';
    }
    return undefined;
  },

  async run(tc: TaskContext<DedupRemoveEvents>) {
    const playlists = tc.body.playlists as Array<{
      id: string;
      uris: string[];
    }>;
    let totalRemoved = 0;

    await tc.iter(playlists, async (pl) => {
      const batchSize = 100;
      const chunks: string[][] = [];
      for (let i = 0; i < pl.uris.length; i += batchSize) {
        chunks.push(pl.uris.slice(i, i + batchSize));
      }
      await tc.iter(chunks, async (batch) => {
        await tc.client.api.playlists.removeItemsFromPlaylist(pl.id, {
          tracks: batch.map((uri) => ({ uri })),
        });
        totalRemoved += batch.length;
      });
    });

    tc.emit('dedup:complete', { totalRemoved });
    tc.log('success', `Removed ${totalRemoved} duplicate tracks`);
  },

  cleanup(tc) {
    invalidateNonListenedCache(tc.dataDir);
  },
};
