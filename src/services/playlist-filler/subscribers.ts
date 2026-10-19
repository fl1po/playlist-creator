import {
  broadcastEvents,
  type EventHandlers,
} from '../../lib/service-events.js';
import type { TaskProgress } from '../../lib/task-progress.js';
import { describeChange } from '../recalculation/subscribers.js';
import type { PlaylistFillerEventMap } from './events.js';

// ── Console subscriber (CLI) ────────────────────────────────────────────────

export function consoleHandlers(): EventHandlers<PlaylistFillerEventMap> {
  return {
    onStart: (dates) => {
      console.log(`\n${'='.repeat(60)}`);
      console.log('BATCH PLAYLIST FILLER - P1 & P2 ONLY');
      console.log('='.repeat(60));
      console.log(`\nDates to process: ${dates.length}`);
      console.log(`Dates: ${dates.join(', ')}`);
      console.log(`Start time: ${new Date().toISOString()}\n`);
    },
    onDateStart: (date, i, total) => {
      console.log(
        `\n[${'#'.repeat(i + 1)}${'.'.repeat(total - i - 1)}] ${i + 1}/${total}`,
      );
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Processing: ${date}`);
      console.log('='.repeat(60));
    },
    onDateSkipped: (date, reason, trackCount) =>
      console.log(`  ${date}: skipped (${reason}, ${trackCount} tracks)`),
    onPlaylistCreated: (date) => console.log(`Created playlist: ${date}`),
    onPlaylistReused: (date) =>
      console.log(`  Reusing empty playlist: ${date}`),
    onArtistSearchProgress: (searched, total) =>
      console.log(`  ... searched ${searched}/${total} artists`),
    onWeekProgressSaved: (searched, total) =>
      console.log(`  ... week progress saved (${searched}/${total} artists)`),
    onReleaseFound: (artist, release, type, source) => {
      if (source) console.log(`    Found (${source}): ${artist} - ${release}`);
      else console.log(`  Found: ${artist} - ${release} (${type})`);
    },
    onVariantPicked: (name, count, isExplicit) =>
      console.log(
        `    (picked ${isExplicit ? 'explicit' : 'clean'} version of "${name}" from ${count} variants)`,
      ),
    onFiltered: (reason, artist, release, detail) =>
      console.log(
        `  Filtered out (${reason}${detail ? ` ${detail}` : ''}): ${artist} - ${release}`,
      ),
    onDeluxeDetected: (name, baseName, origCount, bonus) =>
      console.log(
        `  Deluxe detected: "${name}" → base: "${baseName}" (orig: ${origCount}, bonus: ${bonus})`,
      ),
    onSingleSkipped: (name) =>
      console.log(`  Skipped single "${name}" - tracks already on album`),
    onDateCompleted: (result) => {
      console.log(`\n  Summary: ${result.tracksAdded} tracks added`);
      console.log(
        `    Albums: ${result.albumsCount}, Singles: ${result.singlesCount}`,
      );
      console.log(`    Skipped (duplicates): ${result.skippedCount}`);
      console.log(`  URL: ${result.playlistUrl}`);
    },
    onDateError: (date, err) =>
      console.error(`\n  ERROR processing ${date}: ${err.message}`),
    onRateLimitSleep: (hours, wakeTime) => {
      console.log(`\n!!! RATE LIMIT: Sleeping for ${hours} hours...`);
      console.log(`    Will resume at: ${wakeTime.toLocaleTimeString()}`);
    },
    onRecalculating: () =>
      console.log('Playlist changed. Recalculating artist priorities...\n'),
    onRecalculated: (changes) => {
      if (changes.length === 0) {
        console.log('Priorities recalculated (no tier changes).\n');
        return;
      }
      console.log(`Priorities recalculated (${changes.length} tier changes):`);
      for (const c of changes) console.log(`  ${describeChange(c)}`);
      console.log('');
    },
    onBatchComplete: (results, minutes) => {
      console.log(`\n${'='.repeat(60)}`);
      console.log('BATCH COMPLETE');
      console.log('='.repeat(60));
      const skipped = results.filter((r) => r.skipped);
      const created = results.filter((r) => !(r.error || r.skipped));
      const errors = results.filter((r) => r.error);
      console.log(`\nTotal time: ${minutes} minutes`);
      console.log(`Playlists skipped (already existed): ${skipped.length}`);
      console.log(`Playlists created this run: ${created.length}`);
      const totalTracks = results.reduce(
        (sum, r) => sum + (r.tracksAdded || 0),
        0,
      );
      console.log(`Total tracks: ${totalTracks}`);
      if (errors.length > 0) {
        console.log(`\nErrors (${errors.length}):`);
        for (const err of errors) console.log(`  ${err.date}: ${err.error}`);
      }
    },
    onLog: (msg) => console.log(msg),
    onWarning: (msg) => console.warn(`  Warning: ${msg}`),
    // resumed: CLI doesn't need to restore any UI state.
  };
}

// ── Broadcast subscriber (web) ──────────────────────────────────────────────

export interface BroadcastHandlersOptions {
  /** The owner's view of where the fill is (ADR-0006). */
  progress: TaskProgress;
  /** Throws if the user requested abort. Called at hot-path events. */
  checkAbort: () => void;
}

export function broadcastHandlers(
  broadcast: (type: string, data: unknown) => void,
  opts: BroadcastHandlersOptions,
): EventHandlers<PlaylistFillerEventMap> {
  const { progress, checkAbort } = opts;
  /** Index of the date being filled, for the step strip. */
  let current = 0;
  const base = broadcastEvents<PlaylistFillerEventMap>(broadcast, {
    start: {
      type: 'fill:start',
      pack: (dates) => {
        checkAbort();
        progress.steps(dates);
        progress.bar('fillCurrent', 0, 1, 'Starting...');
        return { dates };
      },
    },
    dateStart: {
      log: (date, index, total) => {
        checkAbort();
        current = index;
        progress.step(index, 'active');
        progress.bar('fillCurrent', 0, 1, `${date}: starting...`);
        return `[${index + 1}/${total}] Processing: ${date}`;
      },
    },
    dateSkipped: {
      log: (date, reason, trackCount) =>
        `Skipped ${date}: ${reason} (${trackCount} tracks)`,
    },
    playlistCreated: {
      log: (date) => `Created playlist: ${date}`,
      level: 'success',
    },
    playlistReused: {
      log: (date) => `Reusing empty playlist: ${date}`,
    },
    weekProgressSaved: {
      log: (searched, total) =>
        `Week progress saved (${searched}/${total} artists)`,
    },
    releaseFound: {
      type: 'fill:releaseFound',
      pack: (artist, release, type, source) => ({
        artist,
        release,
        type,
        source,
      }),
    },
    variantPicked: {
      log: (name, count, isExplicit) =>
        `Picked ${isExplicit ? 'explicit' : 'clean'} variant of "${name}" (${count} variants)`,
    },
    filtered: {
      log: (reason, artist, release, detail) =>
        `Filtered (${reason}${detail ? ` ${detail}` : ''}): ${artist} - ${release}`,
    },
    titleTrackOnly: {
      log: (releaseName, _trackName, oldTracks, totalOther) =>
        `Title track only: "${releaseName}" — ${oldTracks}/${totalOther} other tracks from older releases`,
    },
    deluxeDetected: {
      log: (name, baseName) => `Deluxe detected: "${name}" -> "${baseName}"`,
    },
    singleSkipped: {
      log: (name) => `Skipped single "${name}" (tracks already on album)`,
    },
    dateCompleted: {
      type: 'fill:dateComplete',
      pack: (result) => {
        progress.step(current, result.skipped ? 'skipped' : 'done');
        progress.bar(
          'fillCurrent',
          1,
          1,
          `${result.date}: done — ${result.tracksAdded} tracks`,
        );
        return result;
      },
    },
    dateError: {
      type: 'fill:error',
      pack: (date, err) => {
        progress.step(current, 'error');
        return { date, message: err.message };
      },
    },
    recalculating: {
      log: () => 'Playlist changed — recalculating priorities...',
    },
    recalculated: {
      type: 'fill:recalculated',
      pack: (changes) => ({ changes }),
    },
    batchComplete: {
      type: 'fill:complete',
      pack: (results, duration) => {
        // The trailing promotion sync may still run; the dates are done.
        progress.steps([]);
        progress.clearBar('fillCurrent');
        return { results, duration };
      },
    },
    log: { log: (msg) => msg },
    warning: { log: (msg) => msg, level: 'warn' },
  });

  // Hand-written rather than broadcastEvents entries: each sends a log line
  // only some of the time.
  return {
    ...base,
    onArtistSearchProgress: (searched, total, artistName) => {
      checkAbort();
      progress.mark(artistName);
      progress.bar(
        'fillCurrent',
        searched,
        total,
        `Searching artists: ${searched}/${total}`,
      );
      if (searched % 50 === 0 || searched === total) {
        broadcast('log', {
          level: 'info',
          message: `  Searched ${searched}/${total} artists`,
        });
      }
    },
    onResumed: (resumeDate, resumedArtistNames) => {
      if (resumedArtistNames.length === 0) return;
      progress.mark(...resumedArtistNames);
      broadcast('log', {
        level: 'info',
        message: `Restored ${resumedArtistNames.length} searched artists from cache${resumeDate ? ` (date: ${resumeDate})` : ''}`,
      });
    },
  };
}
