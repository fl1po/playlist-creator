import { filterByPriority } from '../../domain/artists.js';
import type { RequestPacer } from '../../lib/request-pacer.js';
import type { SpotifyContext } from '../../lib/spotify-context.js';
import type {
  DateResult,
  SpotifyClient,
  TrustedArtistsFile,
} from '../../lib/types.js';
import { syncIfNeeded } from '../../web/priority-diff.js';
import type { PriorityChange } from '../playlist-syncer.js';
import type { PlaylistFillerOptions } from './events.js';
import { orchestrateFill } from './orchestrator.js';
import type { FillPresenter } from './presenter.js';
import type { FillHistoryEntry, FillStorage } from './storage.js';

export type {
  PlaylistFillerEventMap,
  PlaylistFillerOptions,
  ExternalPlaylistSource,
  EditorialFilterConfig,
} from './events.js';
export {
  FileStorage,
  RedisAndClientStorage,
  type FillStorage,
  type FillHistoryEntry,
  type ProgressFile,
} from './storage.js';
export {
  ConsolePresenter,
  BroadcastPresenter,
  type FillPresenter,
  type BeforeRunContext,
} from './presenter.js';

export type PrioritySnapshot = Map<string, number | null>;

export interface FillRunOptions {
  ctx: SpotifyContext;
  config: PlaylistFillerOptions;
  storage: FillStorage;
  presenter: FillPresenter;
  fresh?: boolean;
}

export interface FillResult {
  results: DateResult[];
  durationMinutes: number;
  prioritiesBefore: PrioritySnapshot;
  prioritiesAfter: PrioritySnapshot;
}

/** Computes resumed-artist names from cache; calls presenter.beforeRun. */
async function callBeforeRun(opts: FillRunOptions): Promise<void> {
  if (!opts.presenter.beforeRun || opts.fresh) return;
  try {
    const cache = await opts.storage.loadBatchCache();
    const progress = cache.artistSearchProgress;
    if (!progress || progress.artistsSearched <= 0) {
      await opts.presenter.beforeRun({
        resumeDate: undefined,
        resumedArtistNames: [],
      });
      return;
    }
    const trusted = await opts.storage.loadTrustedArtists();
    const p1p2 = filterByPriority(trusted.artistCounts, [1, 2]);
    const count = Math.min(progress.artistsSearched, p1p2.length);
    const names: string[] = [];
    for (let i = 0; i < count; i++) names.push(p1p2[i][0]);
    await opts.presenter.beforeRun({
      resumeDate: progress.date,
      resumedArtistNames: names,
    });
  } catch {
    /* no cache / trusted file yet */
  }
}

function snapshotFromTrusted(t: TrustedArtistsFile): PrioritySnapshot {
  const m: PrioritySnapshot = new Map();
  for (const [name, data] of Object.entries(t.artistCounts))
    m.set(name, data.priority);
  return m;
}

export async function runFill(opts: FillRunOptions): Promise<FillResult> {
  await callBeforeRun(opts);

  let prioritiesBefore: PrioritySnapshot = new Map();
  try {
    const before = await opts.storage.loadTrustedArtists();
    prioritiesBefore = snapshotFromTrusted(before);
  } catch {
    /* first run */
  }

  const { results, durationMinutes } = await orchestrateFill({
    ctx: opts.ctx,
    storage: opts.storage,
    presenter: opts.presenter,
    config: opts.config,
    fresh: opts.fresh,
  });

  let prioritiesAfter: PrioritySnapshot = new Map();
  try {
    const after = await opts.storage.loadTrustedArtists();
    prioritiesAfter = snapshotFromTrusted(after);
  } catch {
    /* missing */
  }

  return { results, durationMinutes, prioritiesBefore, prioritiesAfter };
}

// ── Web wrapper ──────────────────────────────────────────────────────────────

export interface WebFillRunOptions extends FillRunOptions {
  userId: string;
  rawClient: SpotifyClient;
  pacer: RequestPacer;
  dataDir: string;
  broadcast: (type: string, data: unknown) => void;
}

export async function runWebFill(opts: WebFillRunOptions): Promise<FillResult> {
  const result = await runFill(opts);

  // Write per-run progress file.
  const completed = result.results.filter((r) => !(r.error || r.skipped));
  await opts.storage.saveProgress({
    completed: completed.length,
    total: result.results.length,
    lastProcessed: result.results[result.results.length - 1]?.date,
    results: result.results,
  });

  // Append a fill-history entry if anything got added.
  const totalTracks = completed.reduce((s, r) => s + (r.tracksAdded || 0), 0);
  if (totalTracks > 0) {
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
      datesTotal: result.results.length,
      totalTracks,
      totalAlbums: completed.reduce((s, r) => s + (r.albumsCount || 0), 0),
      totalSingles: completed.reduce((s, r) => s + (r.singlesCount || 0), 0),
      totalSkipped: completed.reduce((s, r) => s + (r.skippedCount || 0), 0),
      releasesByPriority,
    };
    await opts.storage.appendFillHistory(entry);
  }

  // Sync if any P1/P2 boundary crossings occurred.
  const changes: PriorityChange[] = [];
  for (const [name, before] of result.prioritiesBefore) {
    const after = result.prioritiesAfter.get(name) ?? null;
    if (before !== after)
      changes.push({ artist: name, from: before, to: after });
  }
  for (const [name, after] of result.prioritiesAfter) {
    if (!result.prioritiesBefore.has(name))
      changes.push({ artist: name, from: null, to: after });
  }
  try {
    await syncIfNeeded(
      changes,
      opts.rawClient,
      opts.dataDir,
      opts.config.allWeeklyId ?? '',
      opts.pacer,
      opts.broadcast,
    );
  } catch (syncErr) {
    opts.broadcast('log', {
      level: 'warn',
      message: `Post-fill sync failed: ${syncErr}`,
    });
  }

  return result;
}
