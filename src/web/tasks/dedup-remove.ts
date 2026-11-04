import { itemsOf, playlistReads } from '../../lib/playlist-reads/index.js';
import {
  type DedupWrites,
  findDuplicates,
  removeDuplicates,
} from '../../services/dedup.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

interface DedupRemoveEvents extends BaseEvents {
  /** Disarms the page's remove button; the line is logged (ADR-0007). */
  'dedup:complete': { totalRemoved: number };
}

/**
 * Removes the duplicates from the playlists a dedup scan reported. Each
 * playlist is read again live, so what goes is decided by the playlist as it
 * is now, by the same rule the scan used, not by a list the page kept.
 */
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
    const playlists = tc.body.playlists as Array<{ id: string }>;
    const reads = playlistReads(tc.session);
    const { gateway } = tc.session;
    let totalRemoved = 0;

    await tc.iter(playlists, async (pl) => {
      // A live check, not a listing's snapshot: this playlist is edited next.
      const items = itemsOf(await reads.tracks(pl.id));
      const writes: DedupWrites = {
        async removeAll(uri) {
          const r = await gateway.call(
            (api) =>
              api.playlists.removeItemsFromPlaylist(pl.id, {
                tracks: [{ uri }],
              }),
            `remove duplicates from ${pl.id}`,
          );
          if (!r.success) throw r.error;
        },
        async insert(uri, position) {
          const r = await gateway.call(
            (api) => api.playlists.addItemsToPlaylist(pl.id, [uri], position),
            `restore kept copy in ${pl.id}`,
          );
          if (!r.success) throw r.error;
        },
      };
      totalRemoved += await removeDuplicates(
        items,
        findDuplicates(items),
        writes,
      );
    });

    tc.emit('dedup:complete', { totalRemoved });
    tc.log('success', `Removed ${totalRemoved} duplicate tracks`);
  },
};
