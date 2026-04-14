import {
  getNonListenedPlaylists,
  getPlaylistTracksDetailed,
} from '../../lib/pagination.js';
import type { TaskContext, TaskDefinition } from '../task-runner.js';

export const dedupScanTask: TaskDefinition = {
  name: 'dedup-scan',
  path: '/dedup-scan',
  startMessage: 'Dedup scan started',

  async run(tc: TaskContext) {
    const userConfig = tc.userConfigStore.load();
    const me = await tc.client.api.currentUser.profile();

    const { playlists: candidates } = await getNonListenedPlaylists(
      tc.ctx,
      me.id,
      userConfig.sourcePlaylists.allWeeklyId,
      tc.dataDir,
      (msg) => tc.broadcast('log', { level: 'info', message: msg }),
    );

    const scanResults: Array<{
      name: string;
      id: string;
      duplicateCount: number;
      trackUris: string[];
    }> = [];
    let totalDuplicates = 0;

    for (const pl of candidates) {
      tc.checkAbort();
      const tracks = await getPlaylistTracksDetailed(tc.ctx, pl.id);

      const groups = new Map<
        string,
        Array<{ uri: string; name: string; artists: string }>
      >();
      for (const t of tracks) {
        if (!groups.has(t.key)) groups.set(t.key, []);
        groups.get(t.key)?.push(t);
      }

      const duplicates: Array<{
        artist: string;
        track: string;
        count: number;
      }> = [];
      const urisToRemove: string[] = [];

      for (const [, entries] of groups) {
        if (entries.length > 1) {
          duplicates.push({
            artist: entries[0].artists,
            track: entries[0].name,
            count: entries.length,
          });
          for (let i = 1; i < entries.length; i++) {
            urisToRemove.push(entries[i].uri);
          }
        }
      }

      if (duplicates.length > 0) {
        const dupCount = urisToRemove.length;
        totalDuplicates += dupCount;
        scanResults.push({
          name: pl.name,
          id: pl.id,
          duplicateCount: dupCount,
          trackUris: urisToRemove,
        });
        tc.broadcast('dedup:playlist', { name: pl.name, duplicates });
      }
    }

    tc.broadcast('dedup:scanComplete', {
      playlists: scanResults,
      totalDuplicates,
    });
    if (totalDuplicates === 0) {
      tc.broadcast('log', {
        level: 'success',
        message: `No duplicates found (scanned ${candidates.length} playlists)`,
      });
    } else {
      tc.broadcast('log', {
        level: 'info',
        message: `Found ${totalDuplicates} duplicate tracks across ${scanResults.length} playlists (scanned ${candidates.length})`,
      });
    }
  },
};
