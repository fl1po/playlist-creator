import { unprocessedReports } from '../../services/unprocessed-reports/index.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

interface DedupScanEvents extends BaseEvents {
  /** Arms the page's remove button; the lines are logged (ADR-0007). */
  'dedup:scanComplete': {
    playlists: Array<{ name: string; id: string; duplicateCount: number }>;
    totalDuplicates: number;
  };
}

export const dedupScanTask: TaskDefinition<DedupScanEvents> = {
  name: 'dedup-scan',
  path: '/dedup-scan',
  startMessage: 'Dedup scan started',

  async run(tc: TaskContext<DedupScanEvents>) {
    const result = await unprocessedReports(tc.session, {
      log: (msg, level) => tc.log(level ?? 'info', msg),
    }).duplicates({
      onPlaylist: (_done, _total, pl, measured) => {
        if (measured.duplicateCount === 0) return;
        const listed = measured.groups
          .map((g) => `${g.artists} — ${g.name} ×${g.extra.length + 1}`)
          .join(', ');
        tc.log(
          'info',
          `${pl.name}: ${measured.duplicateCount} duplicates (${listed})`,
        );
      },
    });

    tc.emit('dedup:scanComplete', {
      playlists: result.playlists.map(({ id, name, duplicateCount }) => ({
        id,
        name,
        duplicateCount,
      })),
      totalDuplicates: result.totalDuplicates,
    });
    if (result.totalDuplicates === 0) {
      tc.log(
        'success',
        `No duplicates found (scanned ${result.scanned} playlists)`,
      );
    } else {
      tc.log(
        'warn',
        `Found ${result.totalDuplicates} duplicate tracks across ${result.playlists.length} playlists (scanned ${result.scanned})`,
      );
    }
  },
};
