import { filterByPriority } from '../../domain/artists.js';
import { generateFridayDates, parseDate } from '../../domain/tracks.js';
import { abortableSleep } from '../../lib/abort.js';
import { isAuthError } from '../../lib/api-wrapper.js';
import {
  getAllPlaylistTracks,
  getAllUserPlaylists,
} from '../../lib/pagination.js';
import {
  type EventHandlers,
  ServiceEmitter,
} from '../../lib/service-events.js';
import type { SpotifyContext } from '../../lib/spotify-context.js';
import {
  type BatchCache,
  type DateResult,
  type TrustedArtistsFile,
  toCachedScanResult,
} from '../../lib/types.js';
import {
  type SourcePlaylists,
  diffSnapshots,
  fetchSourceSnapshots,
  pickReusableScans,
  recalculate,
  snapshotPrioritiesFrom,
} from '../recalculate.js';
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
import type {
  ExternalPlaylistSource,
  PlaylistFillerEventMap,
  PlaylistFillerOptions,
} from './events.js';
import type { FillStorage } from './storage.js';

export type PrioritySnapshot = Map<string, number | null>;

export interface FillRunOptions {
  ctx: SpotifyContext;
  config: PlaylistFillerOptions;
  storage: FillStorage;
  /** Event handlers — caller composes from `consoleHandlers()` or `broadcastHandlers()`. */
  handlers: EventHandlers<PlaylistFillerEventMap>;
  fresh?: boolean;
}

export interface FillResult {
  results: DateResult[];
  durationMinutes: number;
  prioritiesBefore: PrioritySnapshot;
  prioritiesAfter: PrioritySnapshot;
}

const DEFAULTS = {
  allWeeklyId: '',
  bestOfAllWeeklyId: '',
  editorialPlaylists: [] as Array<{ id: string; name: string }>,
  externalPlaylistSources: [] as ExternalPlaylistSource[],
  editorialFilter: { minPopularity: 10, minFollowers: 100000 },
};

function snapshotFromTrusted(t: TrustedArtistsFile): PrioritySnapshot {
  const m: PrioritySnapshot = new Map();
  for (const [name, data] of Object.entries(t.artistCounts))
    m.set(name, data.priority);
  return m;
}

async function loadPrioritiesSnapshot(
  storage: FillStorage,
): Promise<PrioritySnapshot> {
  try {
    return snapshotFromTrusted(await storage.loadTrustedArtists());
  } catch {
    return new Map();
  }
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
    const trusted = await opts.storage.loadTrustedArtists();
    const p1p2 = filterByPriority(trusted.artistCounts, [1, 2]);
    const count = Math.min(progress.artistsSearched, p1p2.length);
    const names: string[] = [];
    for (let i = 0; i < count; i++) names.push(p1p2[i][0]);
    emitter.emit('resumed', progress.date, names);
  } catch {
    /* no cache / trusted file yet */
  }
}

interface RecalcDeps {
  ctx: SpotifyContext;
  storage: FillStorage;
  emitter: ServiceEmitter<PlaylistFillerEventMap>;
  sources: SourcePlaylists;
  scoring?: PlaylistFillerOptions['scoring'];
}

/**
 * Mid-Fill recalc: if either source playlist's snapshot has changed since the
 * cached one, re-run the priority calculator. Skipped when the current date is
 * mid-search so an in-flight artist scan isn't invalidated.
 *
 * Returns true when a recalc happened (caller should reload trusted artists).
 * Always updates `cache.{aw,boaw}Snapshot` and persists the cache.
 */
async function maybeRecalculate(
  deps: RecalcDeps,
  cache: BatchCache,
  targetDate: string,
): Promise<boolean> {
  const { ctx, storage, emitter, sources, scoring } = deps;

  const live = await fetchSourceSnapshots(ctx, sources);
  const delta = diffSnapshots(cache, live);

  const persistSnapshots = async () => {
    cache.allWeeklySnapshot = live.aw;
    cache.bestOfAllWeeklySnapshot = live.boaw;
    await storage.saveBatchCache(cache);
  };

  if (!delta.anyChanged) {
    emitter.emit('log', 'Snapshots unchanged — skipping recalculation');
    await persistSnapshots();
    return false;
  }

  const progress = cache.artistSearchProgress;
  const midSearch =
    progress && progress.date === targetDate && progress.artistsSearched > 0;
  if (midSearch) {
    await persistSnapshots();
    return false;
  }

  emitter.emit('recalculating');
  const prior = snapshotPrioritiesFrom(await storage.loadTrustedArtists());
  const result = await recalculate({
    ctx,
    sources,
    // Honor the user's configured thresholds/weights instead of recalculate's
    // hardcoded defaults — otherwise a mid-fill recalc silently re-tiers every
    // artist against the wrong thresholds and mass-demotes them.
    scoring: scoring && {
      weights: scoring,
      thresholds: scoring.priorityThresholds,
      featuredMultiplier: scoring.featuredMultiplier,
    },
    preloaded: pickReusableScans(cache, delta),
    prior,
  });

  await storage.saveTrustedArtists(result.trustedArtists);
  cache.awScanCache = toCachedScanResult(result.scanResults.aw);
  cache.boawScanCache = toCachedScanResult(result.scanResults.boaw);
  await persistSnapshots();

  emitter.emit('recalculated', result.tierChanges ?? []);
  return true;
}

export async function runFill(opts: FillRunOptions): Promise<FillResult> {
  const { ctx, storage, config } = opts;
  const emitter = new ServiceEmitter<PlaylistFillerEventMap>(opts.handlers);

  await emitResumedIfAny(opts, emitter);
  const prioritiesBefore = await loadPrioritiesSnapshot(storage);

  const cfg = {
    allWeeklyId: config.allWeeklyId ?? DEFAULTS.allWeeklyId,
    bestOfAllWeeklyId: config.bestOfAllWeeklyId ?? DEFAULTS.bestOfAllWeeklyId,
    useLikedSongs: config.useLikedSongs ?? false,
    editorialPlaylists:
      config.editorialPlaylists ?? DEFAULTS.editorialPlaylists,
    externalPlaylistSources:
      config.externalPlaylistSources ?? DEFAULTS.externalPlaylistSources,
    editorialFilter: config.editorialFilter ?? DEFAULTS.editorialFilter,
    genreFilters: config.genreFilters,
  };

  const dpConfig: DatePipelineConfig = {
    editorialPlaylists: cfg.editorialPlaylists,
    externalPlaylistSources: cfg.externalPlaylistSources,
    editorialFilter: cfg.editorialFilter,
    genreFilters: cfg.genreFilters,
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
    startDate = new Date(2025, 4, 23);
  }

  const today = new Date();
  const allFridays = generateFridayDates(startDate, today);
  const datesToProcess = allFridays.filter((d) => !filledDates.has(d));

  if (datesToProcess.length === 0) {
    emitter.emit('log', 'All weekly playlists are already filled.');
    return {
      results: [],
      durationMinutes: 0,
      prioritiesBefore,
      prioritiesAfter: await loadPrioritiesSnapshot(storage),
    };
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
    await getAllPlaylistTracks(ctx, cfg.allWeeklyId),
  );
  emitter.emit('log', `Loaded ${allWeeklyTracks.size} tracks from All Weekly`);

  // ── Load trusted artists ─────────────────────────────────────────────────
  let trustedArtists: TrustedArtistsFile = await storage.loadTrustedArtists();
  let p1p2Artists = filterByPriority(trustedArtists.artistCounts, [1, 2]);
  emitter.emit('log', `P1+P2 artists: ${p1p2Artists.length}`);

  // ── Per-date batch loop ──────────────────────────────────────────────────
  const results: DateResult[] = [];
  const startTime = Date.now();

  for (let i = 0; i < datesToProcess.length; i++) {
    const targetDate = datesToProcess[i];
    emitter.emit('dateStart', targetDate, i, datesToProcess.length);

    try {
      const recalculated = await maybeRecalculate(
        {
          ctx,
          storage,
          emitter,
          sources: {
            allWeeklyId: cfg.allWeeklyId,
            bestOfAllWeeklyId: cfg.bestOfAllWeeklyId,
            useLikedSongs: cfg.useLikedSongs,
          },
          scoring: config.scoring,
        },
        cache,
        targetDate,
      );

      if (recalculated) {
        trustedArtists = await storage.loadTrustedArtists();
        p1p2Artists = filterByPriority(trustedArtists.artistCounts, [1, 2]);
        emitter.emit('log', `Reloaded P1+P2 artists: ${p1p2Artists.length}`);
      }

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
          i--;
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

  const prioritiesAfter = await loadPrioritiesSnapshot(storage);
  return { results, durationMinutes, prioritiesBefore, prioritiesAfter };
}
