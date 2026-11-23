import {
  type AwBreakdown,
  awBreakdown,
  describeAwBreakdown,
} from '../../domain/aw-breakdown.js';
import { playlistReads } from '../../lib/playlist-reads/index.js';
import { AW_BREAKDOWN } from '../../lib/user-data/index.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

interface AwBreakdownEvents extends BaseEvents {
  'awBreakdown:complete': AwBreakdown;
}

export const awBreakdownTask: TaskDefinition<AwBreakdownEvents> = {
  name: 'aw-breakdown',
  path: '/aw-breakdown',
  startMessage: 'AW breakdown calculation started',

  async run(tc: TaskContext<AwBreakdownEvents>) {
    const userConfig = await tc.userConfig();
    const awId = userConfig.sourcePlaylists.allWeeklyId;

    // All Weekly comes from playlist reads, so an unchanged one costs a
    // single snapshot call and the grouping is recomputed in memory.
    const read = await playlistReads(tc.session).tracks(awId, {
      onProgress: (fetched, total) => {
        tc.checkAbort();
        tc.progress.bar(
          'aw',
          fetched,
          total,
          `Fetching tracks: ${fetched}/${total}`,
        );
      },
    });
    if (!read.success) throw read.error;
    const result = awBreakdown(read.items);

    // The last breakdown, kept until the next; the page shows it on load.
    await tc.session.data.save(AW_BREAKDOWN, result);
    tc.emit('awBreakdown:complete', result);
    tc.log('success', describeAwBreakdown(result, read));
  },
};
