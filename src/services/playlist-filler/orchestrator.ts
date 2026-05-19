import { filterByPriority } from '../../domain/artists.js';
import { generateFridayDates, parseDate } from '../../domain/tracks.js';
import { abortableSleep } from '../../lib/abort.js';
import { isAuthError } from '../../lib/api-wrapper.js';
import {
  getAllPlaylistTracks,
  getAllUserPlaylists,
} from '../../lib/pagination.js';
import { ServiceEmitter } from '../../lib/service-events.js';
import type { SpotifyContext } from '../../lib/spotify-context.js';
import type {
  BatchCache,
  DateResult,
  TrustedArtistsFile,
} from '../../lib/types.js';
import { ReleaseCollector } from '../release-collector.js';
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
import type { FillPresenter } from './presenter.js';
import { maybeRecalculate } from './recalculate.js';
import type { FillStorage } from './storage.js';

const DEFAULTS = {
  allWeeklyId: '',
  bestOfAllWeeklyId: '',
  editorialPlaylists: [] as Array<{ id: string; name: string }>,
  externalPlaylistSources: [] as ExternalPlaylistSource[],
  editorialFilter: { minPopularity: 60, minFollowers: 100000 },
};

export interface OrchestratorOptions {
  ctx: SpotifyContext;
  storage: FillStorage;
  presenter: FillPresenter;
  config: PlaylistFillerOptions;
  fresh?: boolean;
}

export async function orchestrateFill(
  opts: OrchestratorOptions,
): Promise<{ results: DateResult[]; durationMinutes: number }> {
  const { ctx, storage, presenter } = opts;
  const emitter = new ServiceEmitter<PlaylistFillerEventMap>(
    presenter.events(),
  );

  const cfg: Required<
    Pick<
      PlaylistFillerOptions,
      | 'allWeeklyId'
      | 'bestOfAllWeeklyId'
      | 'useLikedSongs'
      | 'editorialPlaylists'
      | 'externalPlaylistSources'
      | 'editorialFilter'
    >
  > & { genreFilters?: PlaylistFillerOptions['genreFilters'] } = {
    allWeeklyId: opts.config.allWeeklyId ?? DEFAULTS.allWeeklyId,
    bestOfAllWeeklyId:
      opts.config.bestOfAllWeeklyId ?? DEFAULTS.bestOfAllWeeklyId,
    useLikedSongs: opts.config.useLikedSongs ?? false,
    editorialPlaylists:
      opts.config.editorialPlaylists ?? DEFAULTS.editorialPlaylists,
    externalPlaylistSources:
      opts.config.externalPlaylistSources ?? DEFAULTS.externalPlaylistSources,
    editorialFilter: opts.config.editorialFilter ?? DEFAULTS.editorialFilter,
    genreFilters: opts.config.genreFilters,
  };

  const collector = new ReleaseCollector(ctx, {
    onVariantPicked: (name, count, isExplicit) =>
      emitter.emit('variantPicked', name, count, isExplicit),
    onInstrumentalSkipped: (artist, release) =>
      emitter.emit('filtered', 'all-instrumental', artist, release),
    onDeluxeDetected: (name, baseName, origCount, bonus) =>
      emitter.emit('deluxeDetected', name, baseName, origCount, bonus),
    onTitleTrackOnly: (releaseName, trackName, oldTracks, totalOther) =>
      emitter.emit(
        'titleTrackOnly',
        releaseName,
        trackName,
        oldTracks,
        totalOther,
      ),
    onSingleSkipped: (name) => emitter.emit('singleSkipped', name),
  });

  const dpConfig: DatePipelineConfig = {
    editorialPlaylists: cfg.editorialPlaylists,
    externalPlaylistSources: cfg.externalPlaylistSources,
    editorialFilter: cfg.editorialFilter,
    genreFilters: cfg.genreFilters,
  };
  const dpDeps: DatePipelineDeps = {
    ctx,
    storage,
    emitter,
    collector,
    config: dpConfig,
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

  // ── Existing playlists / date discovery ───────────────────────────────────
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
    return { results: [], durationMinutes: 0 };
  }

  emitter.emit('start', datesToProcess);

  // ── Load cache ────────────────────────────────────────────────────────────
  let cache: BatchCache = {};
  if (!opts.fresh) cache = await storage.loadBatchCache();

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
          allWeeklyId: cfg.allWeeklyId,
          bestOfAllWeeklyId: cfg.bestOfAllWeeklyId,
          useLikedSongs: cfg.useLikedSongs,
        },
        cache,
        targetDate,
      );

      if (recalculated) {
        const oldArtists = new Map(
          p1p2Artists.map(([name, data]) => [name, data]),
        );
        trustedArtists = await storage.loadTrustedArtists();
        p1p2Artists = filterByPriority(trustedArtists.artistCounts, [1, 2]);
        const newNames = new Set(p1p2Artists.map(([name]) => name));
        const added = p1p2Artists.filter(([name]) => !oldArtists.has(name));
        const removed = [...oldArtists.keys()].filter(
          (name) => !newNames.has(name),
        );
        emitter.emit('log', `Reloaded P1+P2 artists: ${p1p2Artists.length}`);
        for (const [name, data] of added) {
          const oldData = trustedArtists.artistCounts[name];
          const oldP = oldData?.priority;
          const label = oldP ? `P${oldP}` : 'new';
          emitter.emit('log', `  + ${name}: ${label} → P${data.priority}`);
        }
        for (const name of removed) {
          const oldP = oldArtists.get(name)?.priority;
          const newData = trustedArtists.artistCounts[name];
          const newP = newData?.priority ?? null;
          const newLabel = newP ? `P${newP}` : 'none';
          emitter.emit('log', `  − ${name}: P${oldP} → ${newLabel}`);
        }
      }

      if (i > 0 && (i + 1) % 10 === 0) {
        await ctx.client.refreshToken();
      }

      const result = await processDate(
        dpDeps,
        cache,
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
  return { results, durationMinutes };
}
