import {
  acceptedGenres,
  acousticPattern,
  cleanPattern,
  type GenreFilterLists,
  hasRejectedGenre,
  instrumentalPattern,
  slowedPattern,
  spedUpPattern,
} from '../../domain/filters.js';
import {
  groupReleases,
  releaseDateFallbackMatch,
} from '../../domain/releases.js';
import { foldName } from '../../lib/deezer-client.js';
import { isAbort, SpotifyAuthLost } from '../../lib/spotify/errors.js';
import type { FoundRelease, PlaylistAlbumInfo } from '../../lib/types.js';
import {
  type Collected,
  chooseVariant,
  getArtistInWindow,
  type Run,
  type WindowRelease,
} from './engine.js';
import type {
  AiFindsConfig,
  AiPicksRecord,
  AiSkipReason,
  Candidate,
  CandidateReject,
  CandidateRequest,
  CandidateSource,
  JudgePick,
  TasteContext,
  TasteJudge,
  TasteJudgeOutcome,
  TasteJudgeRequest,
  Tier,
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

/** Most candidates the judge sees, scouting-playlist candidates aside. */
const POOL_CAP = 500;
/** The taste context's slice of the roster below P1/P2: share and ceiling. */
const TASTE_SLICE_SHARE = 0.05;
const TASTE_SLICE_MAX = 300;

/** A day-precise date in the window; a month or year one as editorial does. */
const inWindow = (date: string, window: string[]) =>
  date.length === 10
    ? window.includes(date)
    : releaseDateFallbackMatch(date, window);

/** A title for comparison: folded, no featured artists, no punctuation. */
const normaliseTitle = (title: string) =>
  foldName(title)
    .replace(/\s*[([](?:feat|ft|with)\.?\s[^)\]]*[)\]]/g, '')
    .replace(/\s+-\s+(?:feat|ft)\.?\s.*$/, '')
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Folded artist + normalised title: one release across sources. */
const releaseKey = (artist: string, title: string) =>
  `${foldName(artist)}|${normaliseTitle(title)}`;

// ── Pure steps ───────────────────────────────────────────────────────────────

/** What the week already covers, against which a release is new or not. */
interface WeekCoverage {
  window: string[];
  seedNames: string[];
  foundReleases: Map<string, FoundRelease>;
}

/**
 * In the window, by an artist not searched as P1/P2, and not a release the
 * week already found or admitted from editorial (by id or artist + title).
 */
function isNewRelease(
  week: WeekCoverage,
): (
  r: Pick<Candidate, 'releaseDate' | 'artist' | 'title' | 'spotifyAlbumId'>,
) => boolean {
  const seeds = new Set(week.seedNames.map(foldName));
  const found = new Set(
    [...week.foundReleases.values()].map((r) =>
      releaseKey(r.artistName, r.name),
    ),
  );
  return (r) =>
    inWindow(r.releaseDate, week.window) &&
    !seeds.has(foldName(r.artist)) &&
    !(r.spotifyAlbumId && week.foundReleases.has(r.spotifyAlbumId)) &&
    !found.has(releaseKey(r.artist, r.title));
}

/**
 * The pool's first step: the new candidates, with the same release from
 * several sources merged into one.
 */
export function newCandidates(
  candidates: Candidate[],
  week: WeekCoverage,
): Candidate[] {
  return mergeSources(candidates.filter(isNewRelease(week)));
}

/**
 * The pool the judge sees, from the new candidates: rejected genres vetoed,
 * variants collapsed, then the cap.
 */
export function finishPool(
  candidates: Candidate[],
  genreFilters?: GenreFilterLists,
): Candidate[] {
  const allowed = candidates.filter(
    (c) => !hasRejectedGenre(c.genres, genreFilters),
  );
  return capPool(collapseVariants(allowed));
}

/**
 * One candidate per release: matched by UPC first, then by folded artist +
 * normalised title. The first keeps its fields, gains every source and
 * genre, and fills what it lacks from the others.
 */
function mergeSources(candidates: Candidate[]): Candidate[] {
  const merged: Candidate[] = [];
  const byUpc = new Map<string, Candidate>();
  const byKey = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = releaseKey(c.artist, c.title);
    let into = (c.upc && byUpc.get(c.upc)) || byKey.get(key);
    if (into) {
      absorb(into, c);
    } else {
      into = { ...c, genres: [...c.genres], provenance: [...c.provenance] };
      merged.push(into);
    }
    if (c.upc) byUpc.set(c.upc, into);
    byKey.set(key, into);
  }
  return merged;
}

function absorb(into: Candidate, from: Candidate): void {
  addSources(into, from);
  for (const g of from.genres) {
    if (!into.genres.includes(g)) into.genres.push(g);
  }
  into.upc ??= from.upc;
  into.artistFans ??= from.artistFans;
  into.relativePopularity ??= from.relativePopularity;
  into.spotifyAlbumId ??= from.spotifyAlbumId;
}

/** Add the sources `into` lacks: the same source twice is still one. */
function addSources(into: Candidate, from: Candidate): void {
  const have = new Set(into.provenance.map((p) => JSON.stringify(p)));
  for (const p of from.provenance) {
    if (!have.has(JSON.stringify(p))) into.provenance.push(p);
  }
}

const variantPatterns = [
  instrumentalPattern,
  cleanPattern,
  acousticPattern,
  spedUpPattern,
  slowedPattern,
];

/**
 * One candidate per release across its variants, as the engine's variant
 * strip would keep it: the original when the pool has it, otherwise the
 * first variant. Sped-up and slowed variants never land, so they never
 * stay. A dropped variant's sources go to the one kept.
 */
function collapseVariants(candidates: Candidate[]): Candidate[] {
  const kept = new Map<string, Candidate>();
  const dropped: Array<{ group: string; candidate: Candidate }> = [];
  for (const c of candidates) {
    const base = variantPatterns.reduce((t, p) => t.replace(p, ''), c.title);
    const group = releaseKey(c.artist, base);
    const sped = spedUpPattern.test(c.title) || slowedPattern.test(c.title);
    const current = kept.get(group);
    if (!sped && (!current || (base === c.title && current.title !== base))) {
      if (current) dropped.push({ group, candidate: current });
      kept.set(group, c);
    } else {
      dropped.push({ group, candidate: c });
    }
  }
  for (const { group, candidate } of dropped) {
    const into = kept.get(group);
    if (into && into !== candidate) addSources(into, candidate);
  }
  const keep = new Set(kept.values());
  return candidates.filter((c) => keep.has(c));
}

const isScouting = (c: Candidate) =>
  c.provenance.some((p) => p.kind === 'scouting');

/**
 * Over the cap, scouting-playlist candidates all stay and don't count; of
 * the rest, multi-source candidates go first, then by relative popularity,
 * highest first, with missing ratios after ≥0.6 and before <0.6.
 */
function capPool(pool: Candidate[]): Candidate[] {
  const rest = pool.filter((c) => !isScouting(c));
  if (rest.length <= POOL_CAP) return pool;
  const band = (c: Candidate) =>
    c.relativePopularity === null ? 1 : c.relativePopularity >= 0.6 ? 0 : 2;
  const kept = new Set(
    rest
      .sort(
        (a, b) =>
          Number(b.provenance.length >= 2) - Number(a.provenance.length >= 2) ||
          band(a) - band(b) ||
          (b.relativePopularity ?? 0) - (a.relativePopularity ?? 0),
      )
      .slice(0, POOL_CAP),
  );
  return pool.filter((c) => isScouting(c) || kept.has(c));
}

const tierOf = (priority: number | null): Tier =>
  priority === 1 || priority === 2 || priority === 3 || priority === 4
    ? `P${priority}`
    : 'unranked';

/**
 * The P1/P2 artists, then the top 5% of the whole roster by score from below
 * P1/P2 (at most 300), each with its tier; the week's P1/P2 releases; and
 * the accept list as a soft hint.
 */
export function tasteContext(
  input: WeekCollectionInput,
  foundReleases: Map<string, FoundRelease>,
): TasteContext {
  const searched = new Set(input.roster.map(([name]) => name));
  const roster = Object.entries(input.trustedArtists.artistCounts);
  const sliceSize = Math.min(
    TASTE_SLICE_MAX,
    Math.round(roster.length * TASTE_SLICE_SHARE),
  );
  const slice = roster
    .filter(
      ([name, a]) =>
        !searched.has(name) && a.priority !== 1 && a.priority !== 2,
    )
    .sort(([, a], [, b]) => b.score - a.score)
    .slice(0, sliceSize);
  return {
    roster: [
      ...input.roster.map(([name, data]) => ({
        name,
        tier: tierOf(data.priority),
      })),
      ...slice.map(([name, a]) => ({ name, tier: tierOf(a.priority) })),
    ],
    weekReleases: [...foundReleases.values()]
      .filter((r) => r.priority === 1 || r.priority === 2)
      .map((r) => ({ artist: r.artistName, release: r.name })),
    acceptGenres: input.editorial.genreFilters?.accepted ?? acceptedGenres,
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
  week: {
    window: string[];
    foundReleases: Map<string, FoundRelease>;
    /** The editorial and popularity gates' rejects, for a second look. */
    rejects: CandidateReject[];
  },
): Promise<AiPhase> {
  const { window: validDates, foundReleases } = week;
  const phase: AiPhase = {
    picks: [],
    candidates: 0,
    spendUsd: 0,
    exhausted: false,
    trackFailures: new Map(),
  };
  // No key, or no budget left: no pool, no judge call.
  if (!ai.hasApiKey) return skipPhase(run, phase, 'no-api-key');
  const { budgetUsd } = ai;
  if (!(budgetUsd > 0)) return skipPhase(run, phase, 'over-budget');

  const coverage: WeekCoverage = {
    window: validDates,
    seedNames: input.roster.map(([name]) => name),
    foundReleases,
  };
  const scouting = await readScouting(run, input, ai, coverage);
  const roster = Object.entries(input.trustedArtists.artistCounts);
  // Candidate source trouble leaves a smaller pool, not a failed week.
  const raw = await ports.candidates
    .candidates(
      {
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
        scouting,
        rejects: week.rejects,
        window: validDates,
      },
      run.onProgress,
    )
    .catch(degrade(() => []));
  const pool = finishPool(
    await withSpotifyGenres(run, newCandidates(raw, coverage), scouting),
    input.editorial.genreFilters,
  );

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

/**
 * The current contents of the user's scouting playlists, as `{playlist,
 * album}` items: only new releases, and none by a P1/P2 artist's Spotify
 * id either. A playlist that can't be read adds nothing.
 */
async function readScouting(
  run: Run,
  input: WeekCollectionInput,
  ai: AiFindsConfig,
  week: WeekCoverage,
): Promise<CandidateRequest['scouting']> {
  const isNew = isNewRelease(week);
  const seedIds = new Set(
    input.roster.flatMap(([, data]) => data.spotifyId ?? []),
  );
  const items: CandidateRequest['scouting'] = [];
  for (const playlist of ai.scoutingPlaylists) {
    const albums = await run.reads
      .playlistAlbums(playlist.id)
      .catch(degrade(() => new Map<string, PlaylistAlbumInfo>()));
    for (const album of albums.values()) {
      if (
        !seedIds.has(album.artistIds[0]) &&
        isNew({
          releaseDate: album.releaseDate,
          artist: album.artistName,
          title: album.name,
          spotifyAlbumId: album.id,
        })
      ) {
        items.push({ playlist: playlist.name, album });
      }
    }
  }
  return items;
}

/**
 * A candidate only scouting playlists brought in, with no genres from
 * Deezer, takes its artist's Spotify genres (one `artistProfile` call each)
 * so the genre veto still holds; one whose profile can't be read is
 * dropped. A candidate with another source keeps that source's standing.
 */
async function withSpotifyGenres(
  run: Run,
  candidates: Candidate[],
  scouting: CandidateRequest['scouting'],
): Promise<Candidate[]> {
  const artistOf = new Map(
    scouting.map(({ album }) => [album.id, album.artistIds[0]]),
  );
  const kept: Candidate[] = [];
  for (const c of candidates) {
    const artistId = c.spotifyAlbumId && artistOf.get(c.spotifyAlbumId);
    const unchecked =
      artistId &&
      c.genres.length === 0 &&
      c.provenance.every((p) => p.kind === 'scouting');
    if (!unchecked) {
      kept.push(c);
      continue;
    }
    const profile = await run.reads
      .artistProfile(artistId)
      .catch(degrade(() => null));
    if (profile) kept.push({ ...c, genres: profile.genres });
  }
  return kept;
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
