import { type LogLine, line } from '../../lib/task-log.js';
import { describeChanges, describeSync } from '../recalculation/describe.js';
import {
  describeDecision,
  describeWeekProgress,
} from '../week-collection/describe.js';
import type { FillEvent } from './events.js';

/** A fill event's task-log lines, the same in the CLI and the page (ADR-0007). */
export function describeFill(e: FillEvent): LogLine[] {
  switch (e.kind) {
    case 'log':
      return [line(e.message, e.level)];
    case 'resumed':
      return e.artists.length
        ? [
            line(
              `Restored ${e.artists.length} searched artists from cache (date: ${e.date})`,
            ),
          ]
        : [];
    case 'start':
      return [
        line(`Fill started — ${e.dates.length} dates to process`),
        line(`Dates: ${e.dates.join(', ')}`),
      ];
    case 'date-start':
      return [line(`[${e.index + 1}/${e.total}] Processing: ${e.date}`)];
    case 'week':
      return describeWeekProgress(e.event);
    case 'decision':
      return describeDecision(e.decision);
    case 'written': {
      const w = e.write;
      switch (w.outcome) {
        case 'created':
          return [line(`Created playlist: ${w.date}`, 'success')];
        case 'reused':
          return [line(`Reusing empty playlist: ${w.date}`)];
        case 'skipped':
          return [
            line(
              `Skipped ${w.date}: already has tracks (${w.tracksAdded} tracks)`,
            ),
          ];
      }
      return [];
    }
    case 'recalculating':
      return [line('Playlist changed — recalculating priorities...')];
    case 'recalculated':
      return describeChanges(e.changes);
    case 'date-complete': {
      const r = e.result;
      // A skipped date was worded by its write.
      if (r.skipped) return [];
      return [
        line(
          `  ${r.date}: ${r.tracksAdded} tracks added (${r.albumsCount} albums, ${r.singlesCount} singles, ${r.skippedCount} skipped)`,
          'success',
        ),
        ...(r.playlistUrl ? [line(`  URL: ${r.playlistUrl}`)] : []),
      ];
    }
    case 'date-error':
      return [line(`Fill error [${e.date}]: ${e.error.message}`, 'error')];
    case 'complete': {
      const totalTracks = e.results.reduce(
        (s, r) => s + (r.tracksAdded || 0),
        0,
      );
      const skipped = e.results.filter((r) => r.skipped).length;
      const errors = e.results.filter((r) => r.error).length;
      const created = e.results.length - skipped - errors;
      return [
        line(`Fill complete — ${e.durationMinutes} min`, 'success'),
        line(
          `  ${e.results.length} dates: ${created} created, ${skipped} skipped, ${errors} errors`,
          'success',
        ),
        line(`  Total tracks added: ${totalTracks}`, 'success'),
      ];
    }
    case 'sync':
      return describeSync(e.event);
  }
}
