import fs from 'node:fs';
import path from 'node:path';
import { filterByPriority } from '../../domain/artists.js';
import { invalidateNonListenedCache } from '../../lib/pagination.js';
import type {
  ApiCallOptions,
  TrustedArtistsFile,
} from '../../lib/types.js';
import {
  PlaylistFillerService,
  type PlaylistFillerEventMap,
} from '../../services/playlist-filler.js';
import { broadcastEvents } from '../broadcast.js';
import {
  diffPriorities,
  snapshotPriorities,
  syncIfNeeded,
} from '../priority-diff.js';
import type { TaskContext, TaskDefinition } from '../task-runner.js';

const searchedArtists = new Set<string>();

export function getSearchedArtists(): ReadonlySet<string> {
  return searchedArtists;
}

function restoreSearchedArtistsFromCache(
  dataDir: string,
  broadcast: (type: string, data: unknown) => void,
) {
  try {
    const cachePath = path.join(dataDir, 'batch-cache.json');
    const trustedPath = path.join(dataDir, 'trusted-artists.json');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const progress = cache?.artistSearchProgress;
    if (progress?.artistsSearched > 0) {
      const trusted = JSON.parse(fs.readFileSync(trustedPath, 'utf8'));
      const p1p2 = filterByPriority(trusted.artistCounts, [1, 2]);
      const count = Math.min(progress.artistsSearched, p1p2.length);
      for (let i = 0; i < count; i++) {
        searchedArtists.add(p1p2[i][0]);
      }
      broadcast('fill:searchedArtists', [...searchedArtists]);
      broadcast('log', {
        level: 'info',
        message: `Restored ${searchedArtists.size} searched artists from cache (date: ${progress.date})`,
      });
    }
  } catch {
    /* no cache or trusted-artists file */
  }
}

function buildApiCallbacks(
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

export const fillTask: TaskDefinition = {
  name: 'fill',
  path: '/fill',
  startMessage: 'Fill started',
  apiCallbacks: buildApiCallbacks,

  async run(tc: TaskContext) {
    const freshMode = !!tc.body.fresh;
    searchedArtists.clear();
    tc.broadcast('log', {
      level: 'info',
      message: `Starting playlist fill (fresh=${freshMode})...`,
    });
    if (!freshMode) restoreSearchedArtistsFromCache(tc.dataDir, tc.broadcast);

    const userConfig = tc.userConfigStore.load();

    const service = new PlaylistFillerService(
      tc.ctx,
      {
        freshMode,
        allWeeklyId: userConfig.sourcePlaylists.allWeeklyId,
        bestOfAllWeeklyId: userConfig.sourcePlaylists.bestOfAllWeeklyId,
        editorialPlaylists: userConfig.editorialPlaylists,
        externalPlaylistSources: userConfig.externalPlaylistSources,
        genreFilters: userConfig.genreFilters,
        editorialFilter: userConfig.editorialFilter,
        cachePath: path.join(tc.dataDir, 'batch-cache.json'),
        trustedArtistsPath: path.join(tc.dataDir, 'trusted-artists.json'),
      },
      broadcastEvents<PlaylistFillerEventMap>(tc.broadcast, {
        start: {
          type: 'fill:start',
          pack: (dates) => {
            tc.checkAbort();
            return { dates };
          },
        },
        dateStart: {
          type: 'fill:progress',
          pack: (date, index, total) => {
            tc.checkAbort();
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
            tc.checkAbort();
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
          log: (name, baseName) =>
            `Deluxe detected: "${name}" -> "${baseName}"`,
        },
        singleSkipped: {
          log: (name) =>
            `Skipped single "${name}" (tracks already on album)`,
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
          pack: () => ({}),
        },
        batchComplete: {
          type: 'fill:complete',
          pack: (results, duration) => {
            searchedArtists.clear();
            return { results, duration };
          },
        },
        log: { log: (msg) => msg },
      }),
    );

    // Snapshot old priorities before fill
    const trustedPath = path.join(tc.dataDir, 'trusted-artists.json');
    const oldPriorities = snapshotPriorities(trustedPath);

    const results = await service.run();

    // Write progress file
    const completed = results.filter((r) => !(r.error || r.skipped));
    fs.writeFileSync(
      path.join(tc.dataDir, 'batch-p1p2-progress.json'),
      JSON.stringify(
        { completed: completed.length, total: results.length, results },
        null,
        2,
      ),
    );

    // Append to fill history
    const totalTracks = completed.reduce(
      (s, r) => s + (r.tracksAdded || 0),
      0,
    );
    if (totalTracks > 0) {
      const historyPath = path.join(tc.dataDir, 'fill-history.json');
      let history: unknown[] = [];
      try {
        history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      } catch {
        /* first run */
      }
      const releasesByPriority: Record<string, number> = {};
      for (const r of completed) {
        for (const rel of r.releases ?? []) {
          const key =
            rel.priority === 'editorial' ? 'editorial' : `p${rel.priority}`;
          releasesByPriority[key] = (releasesByPriority[key] || 0) + 1;
        }
      }
      history.push({
        timestamp: new Date().toISOString(),
        datesProcessed: completed.length,
        datesTotal: results.length,
        totalTracks,
        totalAlbums: completed.reduce((s, r) => s + (r.albumsCount || 0), 0),
        totalSingles: completed.reduce(
          (s, r) => s + (r.singlesCount || 0),
          0,
        ),
        totalSkipped: completed.reduce(
          (s, r) => s + (r.skippedCount || 0),
          0,
        ),
        releasesByPriority,
      });
      fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
    }

    // Post-fill sync
    try {
      const current = JSON.parse(
        fs.readFileSync(trustedPath, 'utf-8'),
      ) as TrustedArtistsFile;
      const changes = diffPriorities(oldPriorities, current);
      await syncIfNeeded(
        changes,
        tc.rawClient,
        tc.dataDir,
        userConfig.sourcePlaylists.allWeeklyId,
        tc.pacer,
        tc.broadcast,
      );
    } catch (syncErr) {
      tc.broadcast('log', {
        level: 'warn',
        message: `Post-fill sync failed: ${syncErr}`,
      });
    }
  },

  onError(tc: TaskContext, error: unknown, aborted: boolean) {
    if (aborted) {
      tc.broadcast('fill:stopped', {});
    } else {
      tc.broadcast('fill:error', { date: 'batch', message: String(error) });
    }
  },

  cleanup(tc: TaskContext) {
    searchedArtists.clear();
    invalidateNonListenedCache(tc.dataDir);
  },
};
