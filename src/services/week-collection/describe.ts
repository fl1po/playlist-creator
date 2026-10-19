import { type LogLine, line } from '../../lib/task-log.js';
import type { CollectionDecision, WeekProgressEvent } from './index.js';

/** Artists between "Searched done/total" lines. */
const SEARCH_LOG_EVERY = 50;
/** Seeds between "Related artists: done/total" lines. */
const RELATED_LOG_EVERY = 25;

/**
 * A collection decision's task-log lines (ADR-0007). Shared by the fill and
 * promotion sync, so a decision reads the same wherever it was made.
 */
export function describeDecision(d: CollectionDecision): LogLine[] {
  switch (d.kind) {
    case 'release-found':
      return [
        line(
          `  Added: ${d.artist} — ${d.release} (${d.type})${d.source ? ` [${d.source}]` : ''}`,
        ),
      ];
    case 'variant-picked':
      return [
        line(
          `  Picked ${d.explicit ? 'explicit' : 'clean'} variant of "${d.release}" (${d.variantCount} variants)`,
        ),
      ];
    case 'variant-stripped':
      return [line(`  Filtered (${d.reason}): ${d.artist} — ${d.release}`)];
    case 'low-popularity':
      return [
        line(
          `  Filtered (low popularity ${d.popularity}): ${d.artist} — ${d.release}`,
        ),
      ];
    case 'deluxe-stripped':
      return [
        line(
          `  Deluxe detected: "${d.release}" → "${d.baseName}" (${d.bonusTracks} bonus of ${d.originalTrackCount})`,
        ),
      ];
    case 'title-track-only':
      return [
        line(
          `  Title track only: "${d.release}" — ${d.oldTracks}/${d.otherTracks} other tracks from older releases`,
        ),
      ];
    case 'single-skipped':
      return [
        line(`  Skipped single "${d.release}" (tracks already on album)`),
      ];
    case 'ai-pick':
    case 'ai-skipped':
      // Worded live from week progress, when the pick lands or is skipped.
      return [];
  }
}

/** Week progress's task-log lines; most of it is liveness and says nothing. */
export function describeWeekProgress(e: WeekProgressEvent): LogLine[] {
  switch (e.phase) {
    case 'resumed':
      return [
        line(
          `Resuming from cache: ${e.searched}/${e.total} artists searched, ${e.found} releases discovered`,
        ),
      ];
    case 'searching':
      return e.searched % SEARCH_LOG_EVERY === 0 || e.searched === e.total
        ? [line(`  Searched ${e.searched}/${e.total} artists`)]
        : [];
    case 'release-discovered':
      return [
        line(
          `  Discovered: ${e.artist} — ${e.release} (${e.type})${e.source ? ` [${e.source}]` : ''}`,
        ),
      ];
    case 'checkpoint':
      return [line(`  Week progress saved (${e.searched}/${e.total} artists)`)];
    case 'popularity':
      return [line(`Checking popularity: ${e.done}/${e.total}`)];
    case 'related-artists':
      // A first build covers every P1/P2 seed: a line per batch, not per seed.
      return e.done % RELATED_LOG_EVERY === 0 || e.done === e.total
        ? [line(`Related artists: ${e.done}/${e.total}`)]
        : [];
    case 'related-artists-failed':
      return [
        line(`Related artists: ${e.seeds} seeds unresolved/failed`, 'warn'),
      ];
    case 'ai-pick':
      return [
        line(
          `AI pick: ${e.artist} — ${e.release} (${e.confidence}) — ${e.reason}`,
        ),
      ];
    case 'ai-skip': {
      const detail = e.message ? `: ${e.message}` : '';
      return [
        line(
          e.release
            ? `AI pick skipped (${e.reason}): ${e.artist} — ${e.release}${detail}`
            : `AI finds skipped (${e.reason})${detail}`,
          'warn',
        ),
      ];
    }
    case 'ai-summary':
      // The cost appears here and nowhere else.
      return [
        line(
          `AI finds: ${e.picks} picks from ${e.candidates} candidates, $${e.spendUsd.toFixed(2)}`,
        ),
      ];
    case 'editorial':
    case 'collecting':
      return [];
  }
}
