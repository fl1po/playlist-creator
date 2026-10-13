import { groupReleases } from '../../domain/releases.js';
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
  skipped?: 'no-api-key' | 'over-budget' | 'failed';
}

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
  const roster = Object.entries(input.trustedArtists.artistCounts);
  const raw = await ports.candidates.candidates({
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
  });
  const pool = assemblePool(raw, {
    window: validDates,
    seedNames: input.roster.map(([name]) => name),
    foundReleases,
  });

  const outcome = await ports.judge.judge({
    taste: tasteContext(input, foundReleases),
    candidates: pool,
    budgetUsd: ai.budgetUsd,
  });
  const phase: AiPhase = {
    picks: [],
    candidates: pool.length,
    spendUsd: outcome.spendUsd,
  };
  if (!outcome.ok) {
    phase.skipped =
      outcome.failure === 'spend-cap' ? 'failed' : outcome.failure;
    skip(run, phase.skipped, undefined, {
      message: outcome.failure === 'failed' ? outcome.message : undefined,
    });
    return phase;
  }

  for (const { pick, candidate } of applyThreshold(
    outcome.picks,
    pool,
    ai.threshold,
  )) {
    const resolved = await resolvePick(run, candidate, validDates);
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
