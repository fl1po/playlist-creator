import { filterByPriority } from '../../domain/artists.js';
import { sleep } from '../../lib/spotify/clock.js';
import { isAbort, SpotifyAuthLost } from '../../lib/spotify/gateway.js';
import type { DateResult, TrustedArtistsFile } from '../../lib/types.js';
import type { UserConfig } from '../../lib/user-config.js';
import { TRUSTED_ARTISTS } from '../../lib/user-data/index.js';
import type { UserSession } from '../../lib/user-session.js';
import { saveAiPicks } from '../ai-picks.js';
import type {
  PriorityChange,
  PromotionReads,
} from '../promotion-sync/index.js';
import {
  type RecalculationPorts,
  recalculate,
  syncPending,
} from '../recalculation/index.js';
import {
  collectWeek,
  type WeekCollection,
  type WeekCollectionPorts,
} from '../week-collection/index.js';
import {
  type WeeklyPlaylistStore,
  type WeeklyWrite,
  weeklyPlaylists,
} from '../weekly-playlists/index.js';
import { fillPorts } from './adapters.js';
import type { FillEvent } from './events.js';
import {
  DurableFillStorage,
  type FillHistoryEntry,
  type FillStorage,
} from './storage.js';

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
  /**
   * AI finds' candidate source and judge, built once per fill and only for
   * an opted-in user, so nobody else makes candidate or judge calls. Absent
   * when the server has no Anthropic key: an opted-in user then gets
   * `no-api-key` weeks.
   */
  ai?: (fill: { weeks: number }) => AiFindsPorts;
}

export type AiFindsPorts = Required<
  Pick<WeekCollectionPorts, 'candidates' | 'judge'>
>;

/**
 * One fill, for the session's user. Their user data holds the config, the
 * roster, recalculation state, pending priority changes, week progress and
 * fill history; the gateway paces the stop-aware pauses between dates.
 */
export interface FillRun extends UserSession {
  /** Everything the fill reports — `consoleFillSink` or `webFillSink`. */
  onEvent: (e: FillEvent) => void;
  /** Ignore saved week progress: every week's artist search starts over. */
  fresh?: boolean;
}

/** What the fill works from once it has loaded the config. */
interface Fill extends FillRun {
  userConfig: UserConfig;
  storage: FillStorage;
  ports: FillPorts;
}

/**
 * What one fill may spend on AI finds, in USD. It decides whether the next
 * judge call is made, so one call can overshoot it. Never stored: each fill
 * starts with the whole of it.
 */
const AI_FILL_CEILING_USD = 1;

export interface FillResult {
  results: DateResult[];
  durationMinutes: number;
  /** Tier moves from every mid-fill recalculation, in order. */
  priorityChanges: PriorityChange[];
  /** Set when the trailing promotion sync reconciled playlists. */
  syncedPlaylists: number | null;
}

type Emit = (e: FillEvent) => void;

// ── Results ──────────────────────────────────────────────────────────────────

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

// ── History, resume hint ─────────────────────────────────────────────────────

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
        typeof rel.priority === 'number' ? `p${rel.priority}` : rel.priority;
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
  opts: Fill,
  dates: string[],
  emit: Emit,
): Promise<void> {
  if (opts.fresh) return;
  try {
    for (const date of dates) {
      const progress = await opts.ports.week.checkpoints.load(date);
      if (!progress || progress.artistsSearched <= 0) continue;
      const trusted = await opts.data.load(TRUSTED_ARTISTS);
      if (!trusted) return;
      // Week progress stores only a count; the roster is searched in P1/P2
      // order, so the searched artists are its first `count` names.
      const p1p2 = filterByPriority(trusted.artistCounts, [1, 2]);
      const count = Math.min(progress.artistsSearched, p1p2.length);
      emit({
        kind: 'resumed',
        date,
        artists: p1p2.slice(0, count).map(([name]) => name),
      });
      return;
    }
  } catch {
    /* no progress yet */
  }
}

/**
 * Common tail for every fill, regardless of how many dates were processed:
 * append fill history, then promotion-sync whatever priority changes are
 * pending — this fill's mid-fill recalculations', or ones an earlier run left.
 * Both callers (CLI and web) get this for free — a fill isn't done until this
 * has run.
 */
async function finishFill(
  opts: Fill,
  results: DateResult[],
  priorityChanges: PriorityChange[],
  durationMinutes: number,
): Promise<FillResult> {
  const { storage, onEvent } = opts;
  await maybeAppendFillHistory(storage, results);

  // A sync failure shouldn't fail an otherwise-successful fill: the changes
  // stay pending, and the next recalculation or fill applies them.
  let syncedPlaylists: number | null = null;
  try {
    const synced = await syncPending(
      opts,
      (event) => onEvent({ kind: 'sync', event }),
      opts.ports.recalculation,
    );
    if (synced) syncedPlaylists = synced.playlistsSynced;
  } catch (syncErr) {
    if (isAbort(syncErr)) throw syncErr;
    const err = syncErr instanceof Error ? syncErr : new Error(String(syncErr));
    onEvent({
      kind: 'log',
      message: `Post-fill sync failed: ${err.message} — the priority changes stay pending for the next run`,
      level: 'warn',
    });
  }

  return { results, durationMinutes, priorityChanges, syncedPlaylists };
}

// ── Interface ────────────────────────────────────────────────────────────────

/**
 * Fill every unfilled Friday, then promotion-sync whatever is pending. Tests
 * pass fixture `ports`; everything else comes from the session.
 */
export async function runFill(
  run: FillRun,
  ports: FillPorts = fillPorts(run),
): Promise<FillResult> {
  const opts: Fill = {
    ...run,
    userConfig: await run.data.config.load(),
    storage: new DurableFillStorage(run.data),
    ports,
  };
  const { gateway, userId, userConfig, data } = opts;
  const emit = opts.onEvent;
  const log = (message: string) => emit({ kind: 'log', message });
  const weekly = weeklyPlaylists({
    store: ports.weekly,
    userId,
    onListProgress: (fetched, total) =>
      log(`  Playlists read: ${fetched}/${total}`),
  });

  // ── Unfilled Fridays ─────────────────────────────────────────────────────
  log('Loading playlists to determine date range...');
  const datesToProcess = await weekly.unfilledFridays(new Date());
  if (datesToProcess.length === 0) {
    log('All weekly playlists are already filled.');
    return finishFill(opts, [], [], 0);
  }
  log(
    `Unfilled Fridays: ${datesToProcess.length} (${datesToProcess[0]} … ${datesToProcess[datesToProcess.length - 1]})`,
  );
  await emitResumedIfAny(opts, datesToProcess, emit);
  emit({ kind: 'start', dates: datesToProcess });

  // ── Listening history for dedup ──────────────────────────────────────────
  log('Loading All Weekly tracks for duplicate checking...');
  const listeningHistory = new Set(
    await ports.history.playlistTrackIds(
      userConfig.sourcePlaylists.allWeeklyId,
    ),
  );
  log(`Loaded ${listeningHistory.size} tracks from All Weekly`);

  // ── Trusted artists ──────────────────────────────────────────────────────
  let trustedArtists: TrustedArtistsFile | null =
    await data.load(TRUSTED_ARTISTS);
  let p1p2Artists = trustedArtists
    ? filterByPriority(trustedArtists.artistCounts, [1, 2])
    : [];
  log(`P1+P2 artists: ${p1p2Artists.length}`);

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
  // What's left of the AI spend ceiling; nothing once the judge is exhausted.
  let aiBudgetUsd = AI_FILL_CEILING_USD;
  const weekPorts: WeekCollectionPorts =
    userConfig.aiFinds.enabled && ports.ai
      ? { ...ports.week, ...ports.ai({ weeks: datesToProcess.length }) }
      : ports.week;

  for (let i = 0; i < datesToProcess.length; i++) {
    const targetDate = datesToProcess[i];
    emit({
      kind: 'date-start',
      date: targetDate,
      index: i,
      total: datesToProcess.length,
    });

    try {
      if (opts.fresh && !cleared.has(targetDate)) {
        await ports.week.checkpoints.clear(targetDate);
        cleared.add(targetDate);
      }

      // Re-score between weeks, never half-way through one: a checkpointed
      // week, whether mid-search or searched but unwritten, must keep the
      // roster it started with. A change skipped here still registers on the
      // next date.
      const progress = await ports.week.checkpoints.load(targetDate);
      const checkpointed = progress !== null && progress.artistsSearched > 0;
      if (!checkpointed) {
        const recalc = await recalculate(
          opts,
          {
            onProgress: (e) => {
              if (e.phase === 'recalculating') emit({ kind: 'recalculating' });
            },
          },
          ports.recalculation,
        );
        if (recalc.outcome === 'recalculated') {
          trustedArtists = recalc.roster;
          p1p2Artists = filterByPriority(trustedArtists.artistCounts, [1, 2]);
          priorityChanges.push(...recalc.changes);
          emit({ kind: 'recalculated', changes: recalc.changes });
          log(`Reloaded P1+P2 artists: ${p1p2Artists.length}`);
        } else {
          log('Snapshots unchanged — skipping recalculation');
        }
      }
      if (!trustedArtists) {
        throw new Error('No trusted artists roster — run a recalculation');
      }

      const week = await collectWeek(
        {
          week: targetDate,
          roster: p1p2Artists,
          trustedArtists,
          listeningHistory,
          editorial,
          ai: userConfig.aiFinds.enabled
            ? {
                ...userConfig.aiFinds,
                budgetUsd: aiBudgetUsd,
              }
            : undefined,
        },
        weekPorts,
        (event) => emit({ kind: 'week', event }),
      );
      aiBudgetUsd = week.aiExhausted ? 0 : aiBudgetUsd - week.aiSpendUsd;
      for (const decision of week.decisions)
        emit({ kind: 'decision', decision });

      const written = await weekly.write(targetDate, week.tracks);
      // The record goes with the playlist, so a week stopped before its
      // write leaves none. A failed save mustn't fail a written week.
      if (week.aiPicks && written.outcome !== 'skipped') {
        try {
          await saveAiPicks(data, targetDate, week.aiPicks);
        } catch (saveErr) {
          if (isAbort(saveErr)) throw saveErr;
          emit({
            kind: 'log',
            message: `Could not save AI picks for ${targetDate}`,
            level: 'warn',
          });
        }
      }
      // Only a written week is done with its search; any earlier stop
      // resumes from the completed checkpoint. A failed clear mustn't fail a
      // written week: the Friday is filled now, so the next fill skips it.
      try {
        await ports.week.checkpoints.clear(targetDate);
      } catch (clearErr) {
        if (isAbort(clearErr)) throw clearErr;
        log(`Could not clear week progress for ${targetDate}`);
      }
      emit({ kind: 'written', write: written });
      const result = toDateResult(week, written);
      results.push(result);
      emit({ kind: 'date-complete', result });

      if (i < datesToProcess.length - 1) {
        await sleep(2000, gateway.signal);
      }
    } catch (error) {
      if (isAbort(error)) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      emit({ kind: 'date-error', date: targetDate, error: err });
      // The gateway already tried a refresh and a login; week progress lets
      // the next fill resume this week where it stopped.
      if (err instanceof SpotifyAuthLost) throw err;
      results.push({ date: targetDate, error: err.message } as DateResult);
      // Back off before the next date; there's nothing to wait for after the last.
      if (i < datesToProcess.length - 1) {
        await sleep(60000, gateway.signal);
      }
    }
  }

  const durationMinutes = Math.round((Date.now() - startTime) / 1000 / 60);
  emit({ kind: 'complete', results, durationMinutes });

  return finishFill(opts, results, priorityChanges, durationMinutes);
}
