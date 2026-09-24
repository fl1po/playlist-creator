import { filterByPriority } from '../../domain/artists.js';
import { generateFridayDates, parseDate } from '../../domain/tracks.js';
import { abortableSleep } from '../../lib/abort.js';
import { isAuthError } from '../../lib/api-wrapper.js';
import { TRUSTED_ARTISTS } from '../../lib/cache-files.js';
import {
  getAllPlaylistTracks,
  getAllUserPlaylists,
} from '../../lib/pagination.js';
import {
  type EventHandlers,
  ServiceEmitter,
} from '../../lib/service-events.js';
import type { SpotifyContext } from '../../lib/spotify-context.js';
import type {
  BatchCache,
  DateResult,
  TrustedArtistsFile,
} from '../../lib/types.js';
import type { UserConfig } from '../../lib/user-config.js';
import type { PriorityChange } from '../promotion-sync/index.js';
import type { SyncHandlers } from '../promotion-sync/subscribers.js';
import {
  type RecalculationDeps,
  recalculate,
  syncPending,
} from '../recalculation/index.js';
import { syncProgressTo } from '../recalculation/subscribers.js';
import {
  batchCacheCheckpoints,
  deezerPopularitySource,
} from '../week-collection/adapters.js';
import { spotifyReleaseReads } from '../week-collection/spotify-reads.js';
import {
  type DatePipelineConfig,
  type DatePipelineDeps,
  processDate,
} from './date-pipeline.js';
import type { PlaylistFillerEventMap } from './events.js';
import type { FillHistoryEntry, FillStorage, ProgressFile } from './storage.js';

export interface FillRunOptions {
  ctx: SpotifyContext;
  userConfig: UserConfig;
  storage: FillStorage;
  /** Roster + recalculation: re-scored between weeks, synced at the end. */
  recalculation: RecalculationDeps;
  /** Event handlers — caller composes from `consoleHandlers()` or `broadcastHandlers()`. */
  handlers: EventHandlers<PlaylistFillerEventMap>;
  /** Promotion-sync progress/logging — caller composes from `consoleSyncHandlers()` or `broadcastSyncHandlers()`. */
  syncHandlers: SyncHandlers;
  /** Ignore saved week progress: every week's artist search starts over. */
  fresh?: boolean;
}

export interface FillResult {
  results: DateResult[];
  durationMinutes: number;
  /** Tier moves from every mid-fill recalculation, in order. */
  priorityChanges: PriorityChange[];
  /** Set when the trailing promotion sync reconciled playlists. */
  syncedPlaylists: number | null;
}

/** Write the per-run progress file. */
async function writeProgressFile(
  storage: FillStorage,
  results: DateResult[],
): Promise<void> {
  const completed = results.filter((r) => !(r.error || r.skipped));
  const progress: ProgressFile = {
    completed: completed.length,
    total: results.length,
    lastProcessed: results[results.length - 1]?.date,
    results,
  };
  await storage.saveProgress(progress);
}

/** Append a fill-history entry if any tracks were added. */
async function maybeAppendFillHistory(
  storage: FillStorage,
  results: DateResult[],
): Promise<void> {
  const completed = results.filter((r) => !(r.error || r.skipped));
  const totalTracks = completed.reduce((s, r) => s + (r.tracksAdded || 0), 0);
  if (totalTracks === 0) return;

  const releasesByPriority: Record<string, number> = {};
  for (const r of completed) {
    for (const rel of r.releases ?? []) {
      const key =
        rel.priority === 'editorial' ? 'editorial' : `p${rel.priority}`;
      releasesByPriority[key] = (releasesByPriority[key] || 0) + 1;
    }
  }
  const entry: FillHistoryEntry = {
    timestamp: new Date().toISOString(),
    datesProcessed: completed.length,
    datesTotal: results.length,
    totalTracks,
    totalAlbums: completed.reduce((s, r) => s + (r.albumsCount || 0), 0),
    totalSingles: completed.reduce((s, r) => s + (r.singlesCount || 0), 0),
    totalSkipped: completed.reduce((s, r) => s + (r.skippedCount || 0), 0),
    releasesByPriority,
  };
  await storage.appendFillHistory(entry);
}

/** Emit 'resumed' (if applicable) so subscribers can restore UI/log state. */
async function emitResumedIfAny(
  opts: FillRunOptions,
  emitter: ServiceEmitter<PlaylistFillerEventMap>,
): Promise<void> {
  if (opts.fresh) return;
  try {
    const cache = await opts.storage.loadBatchCache();
    const progress = cache.artistSearchProgress;
    if (!progress || progress.artistsSearched <= 0) return;
    const trusted = await opts.recalculation.cache.load(TRUSTED_ARTISTS);
    if (!trusted) return;
    // Week progress stores only a count; the roster is searched in P1/P2
    // order, so the searched artists are its first `count` names.
    const p1p2 = filterByPriority(trusted.artistCounts, [1, 2]);
    const count = Math.min(progress.artistsSearched, p1p2.length);
    const names: string[] = [];
    for (let i = 0; i < count; i++) names.push(p1p2[i][0]);
    emitter.emit('resumed', progress.date, names);
  } catch {
    /* no cache yet */
  }
}

/**
 * Common tail for every fill, regardless of how many dates were processed:
 * persist progress/history, then promotion-sync whatever priority changes are
 * pending — this fill's mid-fill recalculations', or ones an earlier run left.
 * Both callers (CLI and web) get this for free — a fill isn't done until this
 * has run.
 */
async function finishFill(
  opts: FillRunOptions,
  results: DateResult[],
  priorityChanges: PriorityChange[],
  durationMinutes: number,
): Promise<FillResult> {
  const { storage, syncHandlers } = opts;
  await writeProgressFile(storage, results);
  await maybeAppendFillHistory(storage, results);

  // A sync failure shouldn't fail an otherwise-successful fill: the changes
  // stay pending, and the next recalculation or fill applies them.
  let syncedPlaylists: number | null = null;
  try {
    const synced = await syncPending(
      opts.userConfig,
      opts.recalculation,
      syncProgressTo(syncHandlers),
    );
    if (synced) {
      syncHandlers.onComplete(synced);
      syncedPlaylists = synced.playlistsSynced;
    }
  } catch (syncErr) {
    const err = syncErr instanceof Error ? syncErr : new Error(String(syncErr));
    if (err.name === 'AbortError' || err.message === 'Stopped by user') {
      throw err;
    }
    syncHandlers.onLog(
      `Post-fill sync failed: ${err.message} — the priority changes stay pending for the next run`,
      'warn',
    );
  }

  return { results, durationMinutes, priorityChanges, syncedPlaylists };
}

export async function runFill(opts: FillRunOptions): Promise<FillResult> {
  const { ctx, storage } = opts;
  const emitter = new ServiceEmitter<PlaylistFillerEventMap>(opts.handlers);

  await emitResumedIfAny(opts, emitter);

  const { sourcePlaylists } = opts.userConfig;
  const dpConfig: DatePipelineConfig = {
    editorialPlaylists: opts.userConfig.editorialPlaylists,
    externalPlaylistSources: opts.userConfig.externalPlaylistSources,
    editorialFilter: opts.userConfig.editorialFilter,
    genreFilters: opts.userConfig.genreFilters,
  };

  // ── User profile ─────────────────────────────────────────────────────────
  const meResult = await ctx.call(
    () => ctx.api.currentUser.profile(),
    'get user profile',
  );
  if (!meResult.success) {
    if (meResult.authError) {
      await ctx.client.runAuth();
      throw new Error('Auth error getting profile. Re-run after auth.');
    }
    throw new Error('Failed to get user profile');
  }
  const userId = meResult.data.id;

  // ── Existing playlists / date discovery ──────────────────────────────────
  emitter.emit('log', 'Loading playlists to determine date range...');
  const existingPlaylists = await getAllUserPlaylists(ctx, userId);
  emitter.emit('log', `Found ${existingPlaylists.length} user playlists`);

  const weeklyPattern = /^(\d{2}\.\d{2}\.\d{2})$/;
  const filledDates = new Set<string>();
  const allWeeklyDates = new Set<string>();
  for (const playlist of existingPlaylists) {
    const match = playlist.name.match(weeklyPattern);
    if (match) {
      allWeeklyDates.add(match[1]);
      if (playlist.trackCount > 0) filledDates.add(match[1]);
    }
  }

  let startDate: Date;
  if (allWeeklyDates.size > 0) {
    const sorted = [...allWeeklyDates].sort((a, b) => {
      return parseDate(a).getTime() - parseDate(b).getTime();
    });
    startDate = parseDate(sorted[0]);
    emitter.emit('log', `Earliest weekly playlist: ${sorted[0]}`);
  } else {
    // No weekly playlists yet: start from Friday 23.05.25 (month is 0-based).
    startDate = new Date(2025, 4, 23);
  }

  const today = new Date();
  const allFridays = generateFridayDates(startDate, today);
  const datesToProcess = allFridays.filter((d) => !filledDates.has(d));

  if (datesToProcess.length === 0) {
    emitter.emit('log', 'All weekly playlists are already filled.');
    return finishFill(opts, [], [], 0);
  }

  emitter.emit('start', datesToProcess);

  // ── Load cache ───────────────────────────────────────────────────────────
  let cache: BatchCache = {};
  if (!opts.fresh) cache = await storage.loadBatchCache();

  const dpDeps: DatePipelineDeps = {
    ctx,
    emitter,
    ports: {
      reads: spotifyReleaseReads(ctx),
      popularity: deezerPopularitySource(() => {
        void ctx.api; // throws if aborted
      }),
      checkpoints: batchCacheCheckpoints(storage, cache),
    },
    config: dpConfig,
  };

  // ── Load All Weekly tracks for dedup ─────────────────────────────────────
  emitter.emit('log', 'Loading All Weekly tracks for duplicate checking...');
  const allWeeklyTracks = new Set(
    await getAllPlaylistTracks(ctx, sourcePlaylists.allWeeklyId),
  );
  emitter.emit('log', `Loaded ${allWeeklyTracks.size} tracks from All Weekly`);

  // ── Load trusted artists ─────────────────────────────────────────────────
  let trustedArtists: TrustedArtistsFile | null =
    await opts.recalculation.cache.load(TRUSTED_ARTISTS);
  let p1p2Artists = trustedArtists
    ? filterByPriority(trustedArtists.artistCounts, [1, 2])
    : [];
  emitter.emit('log', `P1+P2 artists: ${p1p2Artists.length}`);

  // ── Per-date batch loop ──────────────────────────────────────────────────
  const results: DateResult[] = [];
  const priorityChanges: PriorityChange[] = [];
  const startTime = Date.now();

  for (let i = 0; i < datesToProcess.length; i++) {
    const targetDate = datesToProcess[i];
    emitter.emit('dateStart', targetDate, i, datesToProcess.length);

    try {
      // Re-score between weeks, never half-way through one: an in-flight
      // artist search must keep the roster it started with. A change skipped
      // here still registers on the next date.
      const progress = cache.artistSearchProgress;
      const midSearch =
        progress?.date === targetDate && progress.artistsSearched > 0;
      if (!midSearch) {
        const recalc = await recalculate(opts.userConfig, opts.recalculation, {
          onProgress: (e) => {
            if (e.phase === 'recalculating') emitter.emit('recalculating');
          },
        });
        if (recalc.outcome === 'recalculated') {
          trustedArtists = recalc.roster;
          p1p2Artists = filterByPriority(trustedArtists.artistCounts, [1, 2]);
          priorityChanges.push(...recalc.changes);
          emitter.emit('recalculated', recalc.changes);
          emitter.emit('log', `Reloaded P1+P2 artists: ${p1p2Artists.length}`);
        } else {
          emitter.emit('log', 'Snapshots unchanged — skipping recalculation');
        }
      }
      if (!trustedArtists) {
        throw new Error('No trusted artists roster — run a recalculation');
      }

      // A long fill can outlive the access token; refresh every 10 dates.
      if (i > 0 && (i + 1) % 10 === 0) {
        await ctx.client.refreshToken();
      }

      const result = await processDate(
        dpDeps,
        targetDate,
        p1p2Artists,
        allWeeklyTracks,
        userId,
        existingPlaylists,
        trustedArtists,
      );
      results.push(result);
      emitter.emit('dateCompleted', result);

      if (i < datesToProcess.length - 1) {
        await abortableSleep(2000, ctx.client);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.name === 'AbortError' || err.message === 'Stopped by user') {
        throw err;
      }
      emitter.emit('dateError', targetDate, err);
      if (isAuthError(err)) {
        const ok = await ctx.client.runAuth();
        if (ok) {
          await ctx.client.recreateApi();
          i--; // retry the same date with the fresh token
          continue;
        }
        results.push({ date: targetDate, error: err.message } as DateResult);
        break;
      }
      results.push({ date: targetDate, error: err.message } as DateResult);
      await abortableSleep(60000, ctx.client);
    }
  }

  const durationMinutes = Math.round((Date.now() - startTime) / 1000 / 60);
  emitter.emit('batchComplete', results, durationMinutes);

  return finishFill(opts, results, priorityChanges, durationMinutes);
}
