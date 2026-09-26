import { filterByPriority } from '../../domain/artists.js';
import { abortableSleep } from '../../lib/abort.js';
import { isAuthError } from '../../lib/api-wrapper.js';
import { TRUSTED_ARTISTS } from '../../lib/cache-files.js';
import type { DurableCache } from '../../lib/durable-cache.js';
import {
  type EventHandlers,
  ServiceEmitter,
} from '../../lib/service-events.js';
import type { SpotifyContext } from '../../lib/spotify-context.js';
import type { DateResult, TrustedArtistsFile } from '../../lib/types.js';
import type { UserConfig } from '../../lib/user-config.js';
import type {
  PriorityChange,
  PromotionReads,
} from '../promotion-sync/index.js';
import type { SyncHandlers } from '../promotion-sync/subscribers.js';
import {
  type RecalculationDeps,
  type RecalculationPorts,
  recalculate,
  syncPending,
} from '../recalculation/index.js';
import { syncProgressTo } from '../recalculation/subscribers.js';
import {
  type CollectionDecision,
  type WeekCollection,
  type WeekCollectionPorts,
  type WeekProgressEvent,
  collectWeek,
} from '../week-collection/index.js';
import {
  type WeeklyPlaylistStore,
  type WeeklyWrite,
  weeklyPlaylists,
} from '../weekly-playlists/index.js';
import type { PlaylistFillerEventMap } from './events.js';
import type { FillHistoryEntry, FillStorage, ProgressFile } from './storage.js';

// ── Ports (the seam) ─────────────────────────────────────────────────────────

/**
 * Everything a fill reads or writes outside its own storage. The production
 * set comes from `fillPorts()`; tests pass fixtures.
 */
export interface FillPorts {
  /** Week collection: release reads, popularity, week-progress checkpoints. */
  week: WeekCollectionPorts;
  /** Weekly playlist listing, creation and track writes. */
  weekly: WeeklyPlaylistStore;
  /** The listening history (All Weekly) read, for dedup. */
  history: Pick<PromotionReads, 'playlistTrackIds'>;
  /** Mid-fill recalculation and the trailing promotion sync. */
  recalculation: RecalculationPorts;
}

export interface FillRunOptions {
  /** Kept for token refresh, re-auth and abort-aware sleeps. */
  ctx: SpotifyContext;
  userId: string;
  userConfig: UserConfig;
  /** The fill's own persistence: progress file and fill history. */
  storage: FillStorage;
  /** Holds the roster, recalculation state and pending priority changes. */
  cache: DurableCache;
  ports: FillPorts;
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

type Emitter = ServiceEmitter<PlaylistFillerEventMap>;

// ── Event translation (until the run event stream replaces the event map) ────

/** Map week-collection liveness onto the existing event map. */
function emitProgress(emitter: Emitter, e: WeekProgressEvent): void {
  switch (e.phase) {
    case 'resumed':
      emitter.emit(
        'log',
        `Resuming from cache: ${e.searched}/${e.total} artists searched, ${e.found} releases found`,
      );
      break;
    case 'searching':
      emitter.emit('artistSearchProgress', e.searched, e.total, e.artist);
      break;
    case 'release-found':
      emitter.emit('releaseFound', e.artist, e.release, e.type, e.source);
      break;
    case 'checkpoint':
      emitter.emit('weekProgressSaved', e.searched, e.total);
      break;
    case 'popularity':
      emitter.emit('log', `Checking popularity: ${e.done}/${e.total}`);
      break;
    default:
      break;
  }
}

/** Map collection decisions onto the existing event map. */
function emitDecision(emitter: Emitter, d: CollectionDecision): void {
  switch (d.kind) {
    case 'release-found':
      // Logged live during search/editorial via emitProgress; skip here so the
      // end-of-date decision replay doesn't double-log each find.
      break;
    case 'variant-picked':
      emitter.emit('variantPicked', d.release, d.variantCount, d.explicit);
      break;
    case 'variant-stripped':
      emitter.emit('filtered', d.reason, d.artist, d.release);
      break;
    case 'low-popularity':
      emitter.emit(
        'filtered',
        'low popularity',
        d.artist,
        d.release,
        `${d.popularity}`,
      );
      break;
    case 'deluxe-stripped':
      emitter.emit(
        'deluxeDetected',
        d.release,
        d.baseName,
        d.originalTrackCount,
        d.bonusTracks,
      );
      break;
    case 'title-track-only':
      emitter.emit(
        'titleTrackOnly',
        d.release,
        d.track,
        d.oldTracks,
        d.otherTracks,
      );
      break;
    case 'single-skipped':
      emitter.emit('singleSkipped', d.release);
      break;
  }
}

function emitWrite(emitter: Emitter, w: WeeklyWrite): void {
  switch (w.outcome) {
    case 'created':
      emitter.emit('playlistCreated', w.date, w.playlistId);
      break;
    case 'reused':
      emitter.emit('playlistReused', w.date, w.playlistId);
      break;
    case 'skipped':
      emitter.emit('dateSkipped', w.date, 'already has tracks', w.tracksAdded);
      break;
  }
}

function toDateResult(week: WeekCollection, w: WeeklyWrite): DateResult {
  if (w.outcome === 'skipped') {
    return {
      date: w.date,
      playlistId: w.playlistId,
      playlistUrl: w.playlistUrl,
      tracksAdded: w.tracksAdded,
      albumsCount: 0,
      singlesCount: 0,
      skippedCount: 0,
      releases: [],
      skipped: true,
      reason: 'already has tracks',
    };
  }
  return {
    date: w.date,
    playlistId: w.playlistId,
    playlistUrl: w.playlistUrl,
    tracksAdded: week.tracks.length,
    albumsCount: week.releases.filter((a) => a.type === 'album').length,
    singlesCount: week.releases.filter((a) => a.type === 'single').length,
    skippedCount: week.skippedCount,
    releases: week.releases,
  };
}

// ── Progress file, history, resume hint ──────────────────────────────────────

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

/**
 * Emit 'resumed' if one of the unfilled Fridays has saved week progress, so
 * subscribers can restore UI/log state. Never fails the fill.
 */
async function emitResumedIfAny(
  opts: FillRunOptions,
  dates: string[],
  emitter: Emitter,
): Promise<void> {
  if (opts.fresh) return;
  try {
    for (const date of dates) {
      const progress = await opts.ports.week.checkpoints.load(date);
      if (!progress || progress.artistsSearched <= 0) continue;
      const trusted = await opts.cache.load(TRUSTED_ARTISTS);
      if (!trusted) return;
      // Week progress stores only a count; the roster is searched in P1/P2
      // order, so the searched artists are its first `count` names.
      const p1p2 = filterByPriority(trusted.artistCounts, [1, 2]);
      const count = Math.min(progress.artistsSearched, p1p2.length);
      emitter.emit(
        'resumed',
        date,
        p1p2.slice(0, count).map(([name]) => name),
      );
      return;
    }
  } catch {
    /* no progress yet */
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
  recalculation: RecalculationDeps,
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
      recalculation,
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

// ── Interface ────────────────────────────────────────────────────────────────

export async function runFill(opts: FillRunOptions): Promise<FillResult> {
  const { ctx, userId, userConfig, cache, ports } = opts;
  const emitter = new ServiceEmitter<PlaylistFillerEventMap>(opts.handlers);
  const recalculation: RecalculationDeps = {
    cache,
    ports: ports.recalculation,
  };
  const weekly = weeklyPlaylists({
    store: ports.weekly,
    userId,
    invalidateUnprocessed: () => ports.recalculation.unprocessed.invalidate(),
  });

  // ── Unfilled Fridays ─────────────────────────────────────────────────────
  emitter.emit('log', 'Loading playlists to determine date range...');
  const datesToProcess = await weekly.unfilledFridays(new Date());
  if (datesToProcess.length === 0) {
    emitter.emit('log', 'All weekly playlists are already filled.');
    return finishFill(opts, recalculation, [], [], 0);
  }
  emitter.emit(
    'log',
    `Unfilled Fridays: ${datesToProcess.length} (${datesToProcess[0]} … ${datesToProcess[datesToProcess.length - 1]})`,
  );
  await emitResumedIfAny(opts, datesToProcess, emitter);
  emitter.emit('start', datesToProcess);

  // ── Listening history for dedup ──────────────────────────────────────────
  emitter.emit('log', 'Loading All Weekly tracks for duplicate checking...');
  const listeningHistory = new Set(
    await ports.history.playlistTrackIds(
      userConfig.sourcePlaylists.allWeeklyId,
    ),
  );
  emitter.emit('log', `Loaded ${listeningHistory.size} tracks from All Weekly`);

  // ── Trusted artists ──────────────────────────────────────────────────────
  let trustedArtists: TrustedArtistsFile | null =
    await cache.load(TRUSTED_ARTISTS);
  let p1p2Artists = trustedArtists
    ? filterByPriority(trustedArtists.artistCounts, [1, 2])
    : [];
  emitter.emit('log', `P1+P2 artists: ${p1p2Artists.length}`);

  const editorial = {
    playlists: userConfig.editorialPlaylists,
    externalSources: userConfig.externalPlaylistSources,
    gate: userConfig.editorialFilter,
    genreFilters: userConfig.genreFilters,
  };

  // ── Per-date loop ────────────────────────────────────────────────────────
  const results: DateResult[] = [];
  const priorityChanges: PriorityChange[] = [];
  const startTime = Date.now();
  // `fresh` drops saved progress once per date, not on an auth retry of it.
  const cleared = new Set<string>();

  for (let i = 0; i < datesToProcess.length; i++) {
    const targetDate = datesToProcess[i];
    emitter.emit('dateStart', targetDate, i, datesToProcess.length);

    try {
      if (opts.fresh && !cleared.has(targetDate)) {
        await ports.week.checkpoints.clear(targetDate);
        cleared.add(targetDate);
      }

      // Re-score between weeks, never half-way through one: an in-flight
      // artist search must keep the roster it started with. A change skipped
      // here still registers on the next date.
      const progress = await ports.week.checkpoints.load(targetDate);
      const midSearch = progress !== null && progress.artistsSearched > 0;
      if (!midSearch) {
        const recalc = await recalculate(userConfig, recalculation, {
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

      const week = await collectWeek(
        {
          week: targetDate,
          roster: p1p2Artists,
          trustedArtists,
          listeningHistory,
          editorial,
        },
        ports.week,
        (e) => emitProgress(emitter, e),
      );
      for (const d of week.decisions) emitDecision(emitter, d);

      const written = await weekly.write(targetDate, week.tracks);
      emitWrite(emitter, written);
      const result = toDateResult(week, written);
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
      // Back off before the next date; there's nothing to wait for after the last.
      if (i < datesToProcess.length - 1) {
        await abortableSleep(60000, ctx.client);
      }
    }
  }

  const durationMinutes = Math.round((Date.now() - startTime) / 1000 / 60);
  emitter.emit('batchComplete', results, durationMinutes);

  return finishFill(
    opts,
    recalculation,
    results,
    priorityChanges,
    durationMinutes,
  );
}
