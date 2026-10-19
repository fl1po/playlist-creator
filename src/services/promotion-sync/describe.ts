import { type LogLine, line } from '../../lib/task-log.js';
import { describeDecision } from '../week-collection/describe.js';
import type {
  PromotionProgressEvent,
  PromotionSyncResult,
  SyncDecision,
} from './index.js';

/** A sync decision's task-log lines (ADR-0007). */
export function describeSyncDecision(d: SyncDecision): LogLine[] {
  switch (d.kind) {
    case 'demotion-removed':
    case 'demotion-kept':
      // Removals are worded per playlist, from its playlist-synced progress.
      return [];
    default:
      return describeDecision(d);
  }
}

export function describePromotionProgress(
  e: PromotionProgressEvent,
): LogLine[] {
  if (e.phase === 'start') {
    return [
      line(
        `Playlist sync started — ${e.demoted} demoted, ${e.promoted} promoted, ${e.playlists} playlist(s)`,
      ),
    ];
  }
  const removed = e.removedArtists?.length
    ? ` (removed ${e.removedArtists.join(', ')})`
    : '';
  const added = e.addedArtists?.length
    ? ` (added ${e.addedArtists.join(', ')})`
    : '';
  return [
    line(
      `  Synced "${e.playlist}": −${e.removed} +${e.added}${removed}${added}`,
    ),
  ];
}

export function describeSyncResult(result: PromotionSyncResult): LogLine[] {
  return [
    ...result.decisions.flatMap(describeSyncDecision),
    line(
      `Playlist sync complete — ${result.removed} removed, ${result.added} added across ${result.playlistsSynced} playlist(s)`,
      'success',
    ),
  ];
}
