import { getPlaylistTracksDetailed } from '../../lib/pagination.js';
import { getNonListenedPlaylists } from '../../services/non-listened-playlists.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

interface DedupScanEvents extends BaseEvents {
  'dedup:playlist': {
    name: string;
    duplicates: Array<{ artist: string; track: string; count: number }>;
  };
  'dedup:scanComplete': {
    playlists: Array<{
      name: string;
      id: string;
      duplicateCount: number;
      trackUris: string[];
    }>;
    totalDuplicates: number;
  };
}

export const dedupScanTask: TaskDefinition<DedupScanEvents> = {
  name: 'dedup-scan',
  path: '/dedup-scan',
  startMessage: 'Dedup scan started',

  async run(tc: TaskContext<DedupScanEvents>) {
    const userConfig = await tc.userConfig();
    const me = await tc.me();

    const { playlists: candidates } = await getNonListenedPlaylists(
      tc.ctx,
      me.id,
      userConfig.sourcePlaylists.allWeeklyId,
      tc.dataDir,
      (msg, level) => tc.log(level ?? 'info', msg),
    );

    const scanResults: Array<{
      name: string;
      id: string;
      duplicateCount: number;
      trackUris: string[];
    }> = [];
    let totalDuplicates = 0;

    await tc.iter(candidates, async (pl) => {
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
        tc.emit('dedup:playlist', { name: pl.name, duplicates });
      }
    });

    tc.emit('dedup:scanComplete', {
      playlists: scanResults,
      totalDuplicates,
    });
    if (totalDuplicates === 0) {
      tc.log(
        'success',
        `No duplicates found (scanned ${candidates.length} playlists)`,
      );
    } else {
      tc.log(
        'info',
        `Found ${totalDuplicates} duplicate tracks across ${scanResults.length} playlists (scanned ${candidates.length})`,
      );
    }
  },
};
