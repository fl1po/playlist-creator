import { itemsOf, playlistReads } from '../../lib/playlist-reads/index.js';
import { findDuplicates } from '../../services/dedup.js';
import { spotifyWeeklyPlaylistStore } from '../../services/weekly-playlists/adapters.js';
import { unprocessedWeeklyPlaylists } from '../../services/weekly-playlists/index.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

interface DedupScanEvents extends BaseEvents {
  /** Arms the page's remove button; the lines are logged (ADR-0007). */
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

    const { playlists: candidates } = await unprocessedWeeklyPlaylists(
      {
        store: spotifyWeeklyPlaylistStore(tc.session),
        userId: me.id,
      },
      userConfig.sourcePlaylists.allWeeklyId,
      (msg, level) => tc.log(level ?? 'info', msg),
    );

    const scanResults: Array<{
      name: string;
      id: string;
      duplicateCount: number;
      trackUris: string[];
    }> = [];
    let totalDuplicates = 0;

    const playlists = playlistReads(tc.session);
    await tc.iter(candidates, async (pl) => {
      const read = await playlists.tracks(pl.id, { snapshot: pl.snapshotId });
      const groups = findDuplicates(itemsOf(read));
      const duplicates = groups.map((g) => ({
        artist: g.artists,
        track: g.name,
        count: g.extra.length + 1,
      }));
      const urisToRemove = groups.flatMap((g) => g.extra.map((e) => e.uri));

      if (duplicates.length > 0) {
        const dupCount = urisToRemove.length;
        totalDuplicates += dupCount;
        scanResults.push({
          name: pl.name,
          id: pl.id,
          duplicateCount: dupCount,
          trackUris: urisToRemove,
        });
        const listed = duplicates
          .map((d) => `${d.artist} — ${d.track} ×${d.count}`)
          .join(', ');
        tc.log('info', `${pl.name}: ${dupCount} duplicates (${listed})`);
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
        'warn',
        `Found ${totalDuplicates} duplicate tracks across ${scanResults.length} playlists (scanned ${candidates.length})`,
      );
    }
  },
};
