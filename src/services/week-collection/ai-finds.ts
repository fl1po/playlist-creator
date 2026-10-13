import { groupReleases } from '../../domain/releases.js';
import { SpotifyAuthLost, isAbort } from '../../lib/spotify/errors.js';
import type { FoundRelease } from '../../lib/types.js';
import {
  type Collected,
  type Run,
  type WindowRelease,
  chooseVariant,
  getArtistInWindow,
} from './engine.js';
import type {
  AiFindsConfig,
  AiPicksRecord,
  AiSkipReason,
  Candidate,
  CandidateSource,
  JudgePick,
  TasteContext,
  TasteJudge,
  TasteJudgeOutcome,
  TasteJudgeRequest,
  WeekCollectionInput,
} from './index.js';

/**
 * The AI finds phase of a week collection (ADR-0005). Pool assembly and the
 * threshold are pure steps; the judge and the Spotify resolution of its picks
 * go through the ports. Picks come back as ordinary `FoundRelease`s for the
 * caller to run through the shape rules, then `landAiPicks` records which
 * ones survived.
 */

export interface AiPhase {
  /** Resolved picks, in the judge's order, one per Spotify album. */
  picks: Array<{ release: FoundRelease; candidate: Candidate }>;
  candidates: number;
  spendUsd: number;
  /** The judge hit the spend cap. */
  exhausted: boolean;
  skipped?: WeekSkipReason;
  /** Picks whose track reads threw: album id → message. */
  trackFailures: Map<string, string>;
}

type WeekSkipReason = 'no-api-key' | 'over-budget' | 'failed';

const releaseKey = (artist: string, title: string) =>
  `${artist.toLowerCase().trim()}|${title.toLowerCase().trim()}`;

// ── Pure steps ───────────────────────────────────────────────────────────────

/**
 * The pool the judge sees: in-window candidates by artists not searched as
 * P1/P2, minus releases the week already found (by id or artist|title).
 */
export function assemblePool(
  candidates: Candidate[],
  context: {
    window: string[];
    seedNames: string[];
    foundReleases: Map<string, FoundRelease>;
  },
): Candidate[] {
  const seeds = new Set(context.seedNames.map((n) => n.toLowerCase().trim()));
  const found = new Set(
    [...context.foundReleases.values()].map((r) =>
      releaseKey(r.artistName, r.name),
    ),
  );
  return candidates.filter(
    (c) =>
      context.window.includes(c.releaseDate) &&
      !seeds.has(c.artist.toLowerCase().trim()) &&
      !(c.spotifyAlbumId && context.foundReleases.has(c.spotifyAlbumId)) &&
      !found.has(releaseKey(c.artist, c.title)),
  );
}

export function tasteContext(
  input: WeekCollectionInput,
  foundReleases: Map<string, FoundRelease>,
): TasteContext {
  return {
    roster: input.roster.map(([name, data]) => ({
      name,
      tier: data.priority === 1 ? 'P1' : 'P2',
    })),
    weekReleases: [...foundReleases.values()]
      .filter((r) => r.priority === 1 || r.priority === 2)
      .map((r) => ({ artist: r.artistName, release: r.name })),
    acceptGenres: input.editorial.genreFilters?.accepted ?? [],
  };
}

/** Picks of pool candidates at or above the threshold, once each. */
export function applyThreshold(
  picks: JudgePick[],
  pool: Candidate[],
  threshold: number,
): Array<{ pick: JudgePick; candidate: Candidate }> {
  const byId = new Map(pool.map((c) => [c.id, c]));
  const kept: Array<{ pick: JudgePick; candidate: Candidate }> = [];
  for (const pick of picks) {
    const candidate = byId.get(pick.id);
    if (!candidate || pick.confidence < threshold) continue;
    byId.delete(pick.id);
    kept.push({ pick, candidate });
  }
  return kept;
}

// ── The phase ────────────────────────────────────────────────────────────────

export async function runAiPhase(
  run: Run,
  input: WeekCollectionInput,
  ai: AiFindsConfig,
  ports: { candidates: CandidateSource; judge: TasteJudge },
  validDates: string[],
  foundReleases: Map<string, FoundRelease>,
): Promise<AiPhase> {
  const phase: AiPhase = {
    picks: [],
    candidates: 0,
    spendUsd: 0,
    exhausted: false,
    trackFailures: new Map(),
  };
  // No budget left, or none passed: no pool, no judge call.
  const budgetUsd = ai.budgetUsd ?? 0;
  if (!(budgetUsd > 0)) return skipPhase(run, phase, 'over-budget');

  const roster = Object.entries(input.trustedArtists.artistCounts);
  // Candidate source trouble leaves a smaller pool, not a failed week.
  const raw = await ports.candidates
    .candidates({
      seeds: input.roster.map(([name, data]) => ({
        name,
        spotifyId: data.spotifyId ?? null,
      })),
      rosterArtists: roster
        .filter(([, a]) => a.priority !== 1 && a.priority !== 2)
        .map(([name, a]) => ({
          name,
          priority: a.priority,
          spotifyId: a.spotifyId,
        })),
      scouting: [],
      rejects: [],
      window: validDates,
    })
    .catch(degrade(() => []));
  const pool = assemblePool(raw, {
    window: validDates,
    seedNames: input.roster.map(([name]) => name),
    foundReleases,
  });

  phase.candidates = pool.length;

  const outcome = await askJudge(ports.judge, {
    taste: tasteContext(input, foundReleases),
    candidates: pool,
    budgetUsd,
  });
  phase.spendUsd = outcome.spendUsd;
  if (!outcome.ok) {
    const failure = weekFailure(outcome);
    phase.exhausted = failure.exhausted;
    return skipPhase(run, phase, failure.reason, failure.message);
  }

  for (const { pick, candidate } of applyThreshold(
    outcome.picks,
    pool,
    ai.threshold,
  )) {
    let resolved: Awaited<ReturnType<typeof resolvePick>>;
    try {
      resolved = await resolvePick(run, candidate, validDates);
    } catch (e) {
      if (escapesPhase(e)) throw e;
      skip(run, 'failed', candidate, { message: errorMessage(e) });
      continue;
    }
    if (!resolved) {
      skip(run, 'not on Spotify', candidate);
      continue;
    }
    const { release, artist } = resolved;
    if (
      foundReleases.has(release.id) ||
      phase.picks.some((p) => p.release.id === release.id)
    ) {
      continue;
    }
    phase.picks.push({
      candidate,
      release: {
        id: release.id,
        name: release.name,
        type: release.type,
        release_date: release.release_date,
        markets: release.markets,
        artistName: artist,
        artistSpotifyId: release.artistId,
        priority: 'ai',
        score: 0,
        aiFind: { confidence: pick.confidence, reason: pick.reason },
      },
    });
  }
  return phase;
}

/** Only stopping the fill and Spotify auth loss get out of the AI phase. */
function escapesPhase(e: unknown): boolean {
  return isAbort(e) || e instanceof SpotifyAuthLost;
}

const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

/** A `.catch` handler that rethrows what escapes the phase, else falls back. */
function degrade<T>(fallback: (e: unknown) => T): (e: unknown) => T {
  return (e) => {
    if (escapesPhase(e)) throw e;
    return fallback(e);
  };
}

/** The judge's outcome; a throw is taken as a failed call that spent nothing. */
function askJudge(
  port: TasteJudge,
  request: TasteJudgeRequest,
): Promise<TasteJudgeOutcome> {
  return port.judge(request).catch(
    degrade((e) => ({
      ok: false as const,
      failure: 'failed' as const,
      message: errorMessage(e),
      spendUsd: 0,
    })),
  );
}

/**
 * How a failed judge call lands on the week. The spend cap is a failed call
 * that also exhausts the judge for the rest of the fill.
 */
function weekFailure(outcome: Extract<TasteJudgeOutcome, { ok: false }>): {
  reason: WeekSkipReason;
  message?: string;
  exhausted: boolean;
} {
  switch (outcome.failure) {
    case 'spend-cap':
      return {
        reason: 'failed',
        message: 'AI spend cap reached; no more AI finds this fill',
        exhausted: true,
      };
    case 'failed':
      return { reason: 'failed', message: outcome.message, exhausted: false };
    default:
      return { reason: outcome.failure, exhausted: false };
  }
}

function skipPhase(
  run: Run,
  phase: AiPhase,
  reason: WeekSkipReason,
  message?: string,
): AiPhase {
  phase.skipped = reason;
  skip(run, reason, undefined, { message });
  return phase;
}

/**
 * For `collectTracks`: a pick whose reads throw (other than abort or auth
 * loss) is dropped and noted for `landAiPicks`; anything else propagates.
 */
export function containPickFailures(
  phase: AiPhase,
): (release: FoundRelease, error: unknown) => boolean {
  return (release, error) => {
    if (!release.aiFind || escapesPhase(error)) return false;
    phase.trackFailures.set(release.id, errorMessage(error));
    return true;
  };
}

/**
 * The pick's Spotify album: its known album id, else one barcode search.
 * Then the engine's variant choice among the artist's same-release variants.
 * Null when Spotify has no in-window album for it.
 */
async function resolvePick(
  run: Run,
  candidate: Candidate,
  validDates: string[],
): Promise<{ release: WindowRelease; artist: string } | null> {
  const album = candidate.spotifyAlbumId
    ? await run.reads.albumDetails(candidate.spotifyAlbumId)
    : candidate.upc
      ? await run.reads.searchByUpc(candidate.upc)
      : null;
  const primary = album?.artists[0];
  if (!(album && primary)) return null;

  const resolved: WindowRelease = {
    id: album.id,
    name: album.name,
    type: album.type,
    release_date: album.release_date,
    artistId: primary.id,
    markets: album.markets,
  };
  const inWindow = await getArtistInWindow(run, primary.id, validDates);
  const group = [...groupReleases(inWindow).values()].find((g) =>
    g.some((r) => r.id === resolved.id),
  ) as WindowRelease[] | undefined;
  if (group) {
    return { release: await chooseVariant(run, group), artist: primary.name };
  }
  // Not among the artist's in-window releases (e.g. a partial album list):
  // land it only if its own date is in the window.
  return validDates.includes(resolved.release_date)
    ? { release: resolved, artist: primary.name }
    : null;
}

function skip(
  run: Run,
  reason: AiSkipReason,
  candidate?: Candidate,
  extra: { message?: string } = {},
): void {
  const release = candidate
    ? { artist: candidate.artist, release: candidate.title }
    : {};
  run.decisions.push({ kind: 'ai-skipped', reason, ...release });
  run.onProgress?.({ phase: 'ai-skip', reason, ...release, ...extra });
}

// ── Landing ──────────────────────────────────────────────────────────────────

/**
 * Record which picks survived the shape rules: an `ai-pick` for each one
 * that kept tracks, a "no tracks left" skip for the rest, then the summary.
 */
export function landAiPicks(
  run: Run,
  phase: AiPhase,
  collected: Collected[],
): AiPicksRecord {
  if (phase.skipped) {
    summarize(run, phase, 0);
    return { skipped: phase.skipped };
  }
  const landed = new Set(collected.map((c) => c.release.id));
  const picks: Extract<AiPicksRecord, { picks: unknown }>['picks'] = [];
  for (const { release, candidate } of phase.picks) {
    const failure = phase.trackFailures.get(release.id);
    if (failure !== undefined) {
      skip(run, 'failed', candidate, { message: failure });
      continue;
    }
    if (!(landed.has(release.id) && release.aiFind)) {
      skip(run, 'no tracks left', candidate);
      continue;
    }
    const { confidence, reason } = release.aiFind;
    picks.push({
      albumId: release.id,
      artist: release.artistName,
      title: release.name,
      confidence,
      reason,
    });
    run.decisions.push({
      kind: 'ai-pick',
      artist: release.artistName,
      release: release.name,
      albumId: release.id,
      confidence,
      reason,
    });
    run.onProgress?.({
      phase: 'ai-pick',
      artist: release.artistName,
      release: release.name,
      confidence,
      reason,
    });
  }
  summarize(run, phase, picks.length);
  return { picks };
}

function summarize(run: Run, phase: AiPhase, picks: number): void {
  run.onProgress?.({
    phase: 'ai-summary',
    picks,
    candidates: phase.candidates,
    spendUsd: phase.spendUsd,
  });
}
