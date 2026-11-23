import { unprocessedReports } from '../../services/unprocessed-reports/index.js';
import type {
  BaseEvents,
  TaskContext,
  TaskDefinition,
} from '../task-runner.js';

export interface DedupRemoveResults {
  /** Disarms the page's remove button; the line is logged (ADR-0007). */
  'dedup:complete': { totalRemoved: number };
}
type DedupRemoveEvents = BaseEvents & DedupRemoveResults;

/** The playlist ids the page sent: the ones its dedup scan reported. */
function requestedIds(body: Record<string, unknown>): string[] | null {
  const playlists = body.playlists;
  if (!Array.isArray(playlists) || playlists.length === 0) return null;
  const ids = playlists.map((p) =>
    p && typeof p === 'object' ? (p as { id?: unknown }).id : undefined,
  );
  return ids.every((id): id is string => typeof id === 'string' && id !== '')
    ? ids
    : null;
}

/**
 * Removes the duplicates from the playlists the user confirmed, through the
 * unprocessed reports: only those still unprocessed weekly playlists when it
 * runs are touched, each read live, by the rule the scan used. Any other id
 * is left alone.
 */
export const dedupRemoveTask: TaskDefinition<DedupRemoveEvents> = {
  name: 'dedup-remove',
  path: '/dedup-remove',
  startMessage: 'Dedup removal started',

  validate(body) {
    return requestedIds(body)
      ? undefined
      : 'playlists array of ids is required';
  },

  async run(tc: TaskContext<DedupRemoveEvents>) {
    const ids = requestedIds(tc.body) ?? [];
    const result = await unprocessedReports(tc.session, {
      log: (msg, level) => tc.log(level ?? 'info', msg),
    }).removeDuplicates(ids, {
      onPlaylist: (_done, _total, pl, removed) =>
        tc.log('info', `${pl.name}: removed ${removed} duplicate tracks`),
    });

    for (const id of result.refused) {
      tc.log('warn', `${id}: not an unprocessed weekly playlist, left alone`);
    }
    tc.emit('dedup:complete', { totalRemoved: result.totalRemoved });
    tc.log('success', `Removed ${result.totalRemoved} duplicate tracks`);
  },
};
