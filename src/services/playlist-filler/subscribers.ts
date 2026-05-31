import {
  type EventHandlers,
  broadcastEvents,
} from '../../lib/service-events.js';
import type { ApiCallOptions } from '../../lib/types.js';
import type { PlaylistFillerEventMap } from './events.js';

// ── Console subscriber (CLI) ────────────────────────────────────────────────

export function consoleApiCallbacks(): ApiCallOptions {
  return {
    onRateLimitWait: (s) => {
      const resumeAt = new Date(Date.now() + s * 1000);
      const display = s >= 60 ? `${(s / 60).toFixed(1)}min` : `${s}s`;
      const time = resumeAt.toLocaleTimeString();
      console.log(`  Rate limited, waiting ${display} (until ${time})...`);
    },
    onNetworkRetry: (a, m) => console.log(`  Network error, retry ${a}/${m}`),
    onLongSleep: (h, w) => {
      console.log(`\n!!! RATE LIMIT: Sleeping for ${h} hours...`);
      console.log(`    Will resume at: ${w.toLocaleTimeString()}`);
    },
    onError: (desc, err) => {
      if (err.message?.includes('404')) return;
      console.log(`  Error (${desc}): ${err.message}`);
    },
  };
}

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
    onArtistSearchPause: () =>
      console.log(`  ... pausing 30s to reset rate limit window`),
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
      if (!changes || changes.length === 0) {
        console.log('Priorities recalculated (no tier changes).\n');
        return;
      }
      const sorted = [...changes].sort(
        (a, b) =>
          (a.to ?? 99) - (b.to ?? 99) || (a.from ?? 99) - (b.from ?? 99),
      );
      console.log(`Priorities recalculated (${sorted.length} tier changes):`);
      for (const c of sorted) {
        const from = c.from === null ? 'new' : `P${c.from}`;
        const to = c.to === null ? 'none' : `P${c.to}`;
        console.log(`  ${from} → ${to}: ${c.artist}`);
      }
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
    // resumed: CLI doesn't need to restore any UI state.
  };
}

// ── Broadcast subscriber (web) ──────────────────────────────────────────────

export interface BroadcastHandlersOptions {
  /** Mutated as artists are searched; reset on batchComplete. */
  searchedArtists: Set<string>;
  /** Throws if the user requested abort. Called at hot-path events. */
  checkAbort: () => void;
}

export function broadcastApiCallbacks(
  broadcast: (type: string, data: unknown) => void,
): ApiCallOptions {
  return {
    onRateLimitWait: (s) => {
      const resumeAt = new Date(Date.now() + s * 1000);
      const display = s >= 60 ? `${(s / 60).toFixed(1)}min` : `${s}s`;
      const time = resumeAt.toLocaleTimeString();
      broadcast('log', {
        level: 'info',
        message: `  Rate limited, waiting ${display} (until ${time})...`,
      });
      broadcast('fill:rateLimited', {
        seconds: s,
        wakeTime: resumeAt.toISOString(),
      });
    },
    onNetworkRetry: (a, m) =>
      broadcast('log', {
        level: 'info',
        message: `  Network error, retry ${a}/${m}`,
      }),
    onLongSleep: (h, w) => {
      broadcast('log', {
        level: 'warn',
        message: `Rate limited — sleeping ${h}h, waking at ${w.toLocaleTimeString()}`,
      });
      broadcast('fill:rateLimited', {
        seconds: h * 3600,
        wakeTime: w.toISOString(),
      });
    },
    onError: (desc, err) => {
      if (err.message?.includes('404')) return;
      broadcast('log', {
        level: 'info',
        message: `  Error (${desc}): ${err.message}`,
      });
    },
  };
}

export function broadcastHandlers(
  broadcast: (type: string, data: unknown) => void,
  opts: BroadcastHandlersOptions,
): EventHandlers<PlaylistFillerEventMap> {
  const { searchedArtists, checkAbort } = opts;
  const base = broadcastEvents<PlaylistFillerEventMap>(broadcast, {
    start: {
      type: 'fill:start',
      pack: (dates) => {
        checkAbort();
        return { dates };
      },
    },
    dateStart: {
      type: 'fill:progress',
      pack: (date, index, total) => {
        checkAbort();
        return { date, index, total, searched: searchedArtists.size };
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
    artistSearchProgress: {
      type: 'fill:searchProgress',
      pack: (searched, total, artistName) => {
        checkAbort();
        searchedArtists.add(artistName);
        return { searched, total, artist: artistName };
      },
    },
    artistSearchPause: {
      log: (searched, total) =>
        `Pausing 30s to reset rate limit window (${searched}/${total} artists)`,
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
      pack: (result) => result,
    },
    dateError: {
      type: 'fill:error',
      pack: (date, err) => ({ date, message: err.message }),
    },
    recalculating: {
      log: () => 'Playlist changed — recalculating priorities...',
    },
    recalculated: {
      type: 'fill:recalculated',
      pack: (tierChanges) => {
        const sorted = [...tierChanges].sort(
          (a, b) =>
            (a.to ?? 99) - (b.to ?? 99) || (a.from ?? 99) - (b.from ?? 99),
        );
        return { changes: sorted };
      },
    },
    batchComplete: {
      type: 'fill:complete',
      pack: (results, duration) => {
        searchedArtists.clear();
        return { results, duration };
      },
    },
    log: { log: (msg) => msg },
  });

  // 'resumed' restores per-artist search state on the web UI.
  // Implemented out-of-band (not via broadcastEvents) because it mutates
  // the searchedArtists set as a side-effect of the event itself.
  return {
    ...base,
    onResumed: (resumeDate, resumedArtistNames) => {
      if (resumedArtistNames.length === 0) return;
      for (const name of resumedArtistNames) searchedArtists.add(name);
      broadcast('fill:searchedArtists', [...searchedArtists]);
      broadcast('log', {
        level: 'info',
        message: `Restored ${searchedArtists.size} searched artists from cache${resumeDate ? ` (date: ${resumeDate})` : ''}`,
      });
    },
  };
}
