/**
 * Year collection orchestrator — the collect phase.
 *
 * Order of operations is chosen to keep the Spotify bill survivable. The
 * pacer runs at one request per second, so every avoidable call costs real
 * wall-clock time:
 *
 *   1. roster genres        batched 50/call  — cheap, and defines the profile
 *   2. Deezer expansion     ~10 req/s        — cheap, off Spotify entirely
 *   3. co-citation cut      free             — sheds ~58% of candidates
 *   4. resolve to Spotify   1/s              — only for survivors
 *   5. relevance cut        free             — down to the candidate limit
 *   6. artist albums        1/s              — the expensive step
 *   7. album details        20/call          — popularity and tracks together
 *   8. Deezer + Last.fm     10/s, 5/s        — off Spotify again
 *
 * Steps 1–2 and 6–8 dominate. Cutting at 3 and 5 is what turns ~12,000
 * Spotify calls into ~3,000.
 */

import { existsSync } from 'node:fs';
import { DeezerClient } from '../../lib/deezer-client.js';
import { LastfmClient } from '../../lib/lastfm-client.js';
import type { SpotifyContext } from '../../lib/spotify-context.js';
import type { TrustedArtistsFile } from '../../lib/types.js';
import {
  CRITIC_WEIGHT,
  FLOOR_PERCENTILE,
  MIN_LASTFM_LISTENERS,
  STREAMING_WEIGHT,
  applyFloor,
  fetchDeezerAcclaim,
  fetchLastfmAcclaim,
  scoreAcclaim,
} from './acclaim.js';
import {
  type DegradedPhase,
  FLUSH_EVERY,
  FailureLog,
  degradedPhases,
  emptyCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
} from './checkpoint.js';
import {
  type RawCandidate,
  cutByCoCitation,
  expandFromSeeds,
} from './expansion.js';
import type { Cluster } from './genre-map.js';
import { type ArtistProfile, type Candidate, SEED_TIERS } from './index.js';
import {
  PLAN_VERSION,
  type PlannedRelease,
  type YearPlan,
  monthOf,
} from './plan.js';
import {
  buildTasteProfile,
  dominantCluster,
  fetchArtistProfiles,
  modalCluster,
  toRoster,
} from './profile.js';
import {
  type AlbumDetail,
  type Rejection,
  type YearRelease,
  fetchAlbumDetails,
  fetchArtistAlbums,
  selectYearReleases,
} from './releases.js';
import { scoreAndCut } from './relevance.js';

/** Candidates cited by fewer seeds than this are noise — 58% sit at exactly 1. */
export const CO_CITATION_THRESHOLD = 2;

/** Artists carried into the expensive album-fetch step. */
export const CANDIDATE_LIMIT = 1_500;

export interface RunOptions {
  ctx: SpotifyContext;
  trustedArtists: TrustedArtistsFile;
  year: number;
  lastfmKey: string;
  coCitationThreshold?: number;
  candidateLimit?: number;
  /** Where the resume checkpoint lives. Omit to run without one. */
  checkpointPath?: string;
  log?: (message: string) => void;
  progress?: (label: string, done: number, total: number) => void;
  checkAbort?: () => void;
}

export interface CollectResult {
  plan: YearPlan;
  degraded: DegradedPhase[];
}

export async function collectYear(opts: RunOptions): Promise<CollectResult> {
  const {
    ctx,
    trustedArtists,
    year,
    lastfmKey,
    coCitationThreshold = CO_CITATION_THRESHOLD,
    candidateLimit = CANDIDATE_LIMIT,
  } = opts;
  const log = opts.log ?? (() => {});
  const progress = opts.progress ?? (() => {});

  const deezer = new DeezerClient();
  const lastfm = new LastfmClient(lastfmKey);

  // Every expensive phase writes here the moment it finishes, and the two
  // longest loops flush as they go. Without it, losing the terminal at minute
  // 110 of a 120-minute run costs the entire run.
  const cpPath = opts.checkpointPath;
  const cp =
    (cpPath ? loadCheckpoint(cpPath, year) : null) ?? emptyCheckpoint(year);
  const failures = new FailureLog(cp);
  const flush = (): void => {
    if (cpPath) {
      saveCheckpoint(cpPath, cp);
    }
  };
  if (cpPath && existsSync(cpPath)) {
    log(`Resuming from checkpoint (${cp.updatedAt})`);
  }

  // ── 1. Taste profile ──────────────────────────────────────────────────────
  const roster = toRoster(trustedArtists);
  log(`Roster: ${roster.length} artists`);

  let rosterProfiles: Map<string, ArtistProfile>;
  if (cp.rosterProfiles) {
    rosterProfiles = new Map(cp.rosterProfiles);
    log(`  reused ${rosterProfiles.size} roster profiles from checkpoint`);
  } else {
    rosterProfiles = await fetchArtistProfiles(
      ctx,
      roster.map((a) => a.spotifyId),
      (done, total) => progress('roster genres', done, total),
      failures.for('roster genres'),
    );
    cp.rosterProfiles = [...rosterProfiles];
    flush();
  }
  const profile = buildTasteProfile(roster, rosterProfiles);
  log(
    `Profile: ${profile.stats.tagged}/${profile.stats.artists} tagged, ` +
      `${profile.stats.distinctGenres} distinct genres`,
  );

  const clusterOfArtist = (id: string): Cluster | null =>
    dominantCluster(rosterProfiles.get(id)?.genres ?? [], profile);

  // ── 2. Deezer expansion ───────────────────────────────────────────────────
  const seeds = roster.filter(
    (a) => a.priority !== null && SEED_TIERS.includes(a.priority),
  );
  let raw: Map<string, RawCandidate>;
  let seedRelations: Map<string, string[]>;
  let unresolved = 0;

  if (cp.expansion) {
    raw = new Map(cp.expansion.candidates);
    seedRelations = new Map(cp.expansion.seedRelations);
    unresolved = cp.expansion.seedsUnresolved;
    log(`  reused ${raw.size} expansion candidates from checkpoint`);
  } else {
    const expanded = await expandFromSeeds(
      deezer,
      seeds,
      (seed) => clusterOfArtist(seed.spotifyId),
      {
        onSeedResolved: (done, total) =>
          progress('deezer expansion', done, total),
        onSeedUnresolved: () => {
          unresolved++;
        },
        checkAbort: opts.checkAbort,
      },
    );
    raw = expanded.candidates;
    seedRelations = expanded.seedRelations;
    cp.expansion = {
      candidates: [...raw],
      seedRelations: [...seedRelations],
      seedsUnresolved: unresolved,
    };
    flush();
  }
  log(`Expansion: ${raw.size} candidates from ${seeds.length} seeds`);

  // ── 3. Co-citation cut ────────────────────────────────────────────────────
  const survivors = cutByCoCitation(raw, coCitationThreshold);
  log(
    `Co-citation >= ${coCitationThreshold}: ${survivors.length} candidates ` +
      `(${raw.size - survivors.length} dropped)`,
  );

  // ── 4. Resolve survivors to Spotify ───────────────────────────────────────
  const rosterByName = new Map(
    roster.map((a) => [a.name.toLowerCase().trim(), a]),
  );
  // Resumable: `doneCount` is an index into `survivors`, which is
  // deterministic given the same expansion and threshold.
  const candidates: Candidate[] = cp.resolution?.resolved
    ? [...cp.resolution.resolved]
    : [];
  const startAt = cp.resolution?.doneCount ?? 0;
  if (startAt > 0) {
    log(`  resuming resolution at ${startAt}/${survivors.length}`);
  }
  const report = failures.for('resolve candidates');

  for (let i = startAt; i < survivors.length; i++) {
    opts.checkAbort?.();
    const survivor = survivors[i];
    progress('resolve candidates', i + 1, survivors.length);

    const known = rosterByName.get(survivor.name.toLowerCase().trim());
    if (known) {
      candidates.push({
        spotifyId: known.spotifyId,
        name: known.name,
        coCitations: survivor.coCitations,
        seedClusters: survivor.seedClusters,
        rosterTier: known.priority ?? undefined,
        profile: rosterProfiles.get(known.spotifyId),
      });
    } else {
      report.attempt();
      const search = await ctx.call(
        () => ctx.api.search(survivor.name, ['artist'], undefined, 5),
        `search artist "${survivor.name}"`,
      );
      if (!search.success) {
        if (search.authError) throw search.error;
        report.fail();
      } else {
        const target = survivor.name.toLowerCase().trim();
        const match = search.data.artists?.items.find(
          (a: { name: string }) => a.name.toLowerCase().trim() === target,
        );
        if (match) {
          candidates.push({
            spotifyId: match.id,
            name: match.name,
            coCitations: survivor.coCitations,
            seedClusters: survivor.seedClusters,
          });
        }
      }
    }

    if ((i + 1) % FLUSH_EVERY === 0) {
      // Snapshot, never alias: `candidates` keeps growing after this phase
      // ends — the roster force-add below pushes into the same array — and a
      // later flush would otherwise rewrite this phase's record with it.
      cp.resolution = { doneCount: i + 1, resolved: [...candidates] };
      flush();
    }
  }
  const resolved = candidates.length;
  cp.resolution = { doneCount: survivors.length, resolved: [...candidates] };
  flush();

  // Every roster artist belongs in the pool, whether or not the graph found
  // them: Q2 made the roster a boost, and Q16 credits all four tiers.
  const inPool = new Set(candidates.map((c) => c.spotifyId));
  for (const artist of roster) {
    if (inPool.has(artist.spotifyId)) continue;
    candidates.push({
      spotifyId: artist.spotifyId,
      name: artist.name,
      coCitations: 0,
      seedClusters: [],
      rosterTier: artist.priority ?? undefined,
      profile: rosterProfiles.get(artist.spotifyId),
    });
  }
  log(`Resolved ${resolved} discovered artists; pool is ${candidates.length}`);

  // ── 5. Genres for discovered artists, then the relevance cut ──────────────
  const missing = candidates.filter((c) => !c.profile).map((c) => c.spotifyId);
  if (missing.length) {
    const fetched = await fetchArtistProfiles(
      ctx,
      missing,
      (done, total) => progress('candidate genres', done, total),
      failures.for('candidate genres'),
    );
    for (const candidate of candidates) {
      if (!candidate.profile)
        candidate.profile = fetched.get(candidate.spotifyId);
    }
  }

  const { kept } = scoreAndCut(candidates, profile, candidateLimit);
  log(`Relevance cut: ${kept.length} artists to search`);

  // Untagged seeds have no cluster of their own and, being force-added rather
  // than discovered, no seed clusters either — they would all land in the
  // reject bucket. Infer from the scene their Deezer neighbours occupy, which
  // costs nothing: those lists were fetched during expansion.
  const clusterByName = new Map<string, Cluster>();
  for (const candidate of kept) {
    if (candidate.cluster && candidate.cluster !== 'other') {
      clusterByName.set(candidate.name.toLowerCase().trim(), candidate.cluster);
    }
  }
  let inferred = 0;
  for (const candidate of kept) {
    if (candidate.cluster) continue;
    const neighbours = seedRelations.get(candidate.spotifyId);
    if (!neighbours?.length) continue;
    const neighbourClusters = neighbours
      .map((name) => clusterByName.get(name))
      .filter((c): c is Cluster => c !== undefined);
    const guess = modalCluster(neighbourClusters);
    if (guess) {
      candidate.cluster = guess;
      candidate.clusterInherited = true;
      inferred++;
    }
  }
  if (inferred) log(`Inferred cluster for ${inferred} untagged artists`);

  // ── 6. Releases ───────────────────────────────────────────────────────────
  // The longest phase by far: ~1,500 artists, several pages each, at one
  // request per second. Flushes every FLUSH_EVERY artists so a disconnect
  // costs minutes rather than the whole sweep.
  const releases: Array<YearRelease & { cluster: Cluster }> =
    cp.albums?.releases ?? [];
  const rejections: Rejection[] = cp.albums?.rejections ?? [];
  const doneArtists = new Set(cp.albums?.doneArtistIds ?? []);
  if (doneArtists.size) {
    log(`  resuming album sweep, ${doneArtists.size} artists already done`);
  }
  const albumReport = failures.for('artist releases');

  for (const [i, candidate] of kept.entries()) {
    opts.checkAbort?.();
    progress('artist releases', i + 1, kept.length);
    if (doneArtists.has(candidate.spotifyId)) continue;

    const albums = await fetchArtistAlbums(
      ctx,
      candidate.spotifyId,
      albumReport,
    );
    const selected = selectYearReleases(
      albums,
      year,
      candidate.spotifyId,
      candidate.name,
    );
    rejections.push(...selected.rejected);

    const cluster =
      candidate.cluster ?? modalCluster(candidate.seedClusters) ?? 'unknown';
    for (const release of selected.releases) {
      releases.push({ ...release, cluster });
    }

    doneArtists.add(candidate.spotifyId);
    if ((i + 1) % FLUSH_EVERY === 0) {
      cp.albums = {
        doneArtistIds: [...doneArtists],
        releases,
        rejections,
      };
      flush();
    }
  }
  cp.albums = { doneArtistIds: [...doneArtists], releases, rejections };
  flush();
  log(`Qualified ${releases.length} releases from ${kept.length} artists`);

  // ── 7. Album details: popularity and track listing in one pass ────────────
  let details: Map<string, AlbumDetail>;
  if (cp.details) {
    details = new Map(cp.details);
    log(`  reused ${details.size} album details from checkpoint`);
  } else {
    details = await fetchAlbumDetails(
      ctx,
      releases.map((r) => r.id),
      (done, total) => progress('album details', done, total),
      failures.for('album details'),
    );
    cp.details = [...details];
    flush();
  }
  const spotifyPop = new Map<string, number>();
  for (const [id, detail] of details) spotifyPop.set(id, detail.popularity);

  // ── 8. Deezer + Last.fm acclaim ───────────────────────────────────────────
  const deezerPop = await fetchDeezerAcclaim(
    deezer,
    releases,
    (done, total) => progress('deezer acclaim', done, total),
    opts.checkAbort,
    failures.for('deezer acclaim'),
    new Map(cp.deezerAcclaim ?? []),
    (partial) => {
      cp.deezerAcclaim = [...partial];
      flush();
    },
  );
  cp.deezerAcclaim = [...deezerPop];
  flush();

  const lastfmData = await fetchLastfmAcclaim(
    lastfm,
    releases,
    (done, total) => progress('lastfm acclaim', done, total),
    opts.checkAbort,
    failures.for('lastfm acclaim'),
    new Map(cp.lastfmAcclaim ?? []),
    (partial) => {
      cp.lastfmAcclaim = [...partial];
      flush();
    },
  );
  cp.lastfmAcclaim = [...lastfmData];
  flush();

  const scored = scoreAcclaim(releases, spotifyPop, deezerPop, lastfmData);
  const { kept: survivorsOfFloor, cut } = applyFloor(scored);
  log(
    `Acclaim floor: ${survivorsOfFloor.length} kept, ${cut.length} cut ` +
      `(bottom ${Math.round(FLOOR_PERCENTILE * 100)}% of each cluster)`,
  );

  // ── 9. Plan ───────────────────────────────────────────────────────────────
  const planned: PlannedRelease[] = survivorsOfFloor.map((release) => {
    const detail = details.get(release.id);
    return {
      ...release,
      trackIds: detail?.trackIds ?? [],
      trackNames: detail?.trackNames ?? [],
      month: monthOf(release.releaseDate, year),
    };
  });

  const fallbackByCluster: Record<string, number> = {};
  const releasesByCluster: Record<string, number> = {};
  const releasesByMonth: Record<string, number> = {};
  for (const release of planned) {
    releasesByCluster[release.cluster] =
      (releasesByCluster[release.cluster] ?? 0) + 1;
    releasesByMonth[release.month] = (releasesByMonth[release.month] ?? 0) + 1;
    if (release.criticFallback) {
      fallbackByCluster[release.cluster] =
        (fallbackByCluster[release.cluster] ?? 0) + 1;
    }
  }

  const plan: YearPlan = {
    version: PLAN_VERSION,
    year,
    generatedAt: new Date().toISOString(),
    config: {
      streamingWeight: STREAMING_WEIGHT,
      criticWeight: CRITIC_WEIGHT,
      minLastfmListeners: MIN_LASTFM_LISTENERS,
      floorPercentile: FLOOR_PERCENTILE,
      coCitationThreshold,
      candidateLimit,
    },
    stats: {
      seeds: seeds.length,
      seedsUnresolved: unresolved,
      candidatesDiscovered: raw.size,
      candidatesAfterCoCitation: survivors.length,
      candidatesScored: candidates.length,
      artistsSearched: kept.length,
      releasesQualified: releases.length,
      releasesAfterFloor: planned.length,
      trackTotal: planned.reduce((sum, r) => sum + r.trackIds.length, 0),
      criticFallbacks: planned.filter((r) => r.criticFallback).length,
      fallbackByCluster,
      releasesByCluster,
      releasesByMonth,
      failures: { ...failures.failures },
      attempts: { ...failures.attempts },
    },
    releases: planned,
    cutByFloor: cut.map((r) => ({
      artistName: r.artistName,
      name: r.name,
      cluster: r.cluster,
      acclaim: r.acclaim,
    })),
    rejections,
  };

  const degraded = degradedPhases(failures);
  for (const phase of degraded) {
    log(
      `  DEGRADED: ${phase.phase} — ${phase.failures}/${phase.attempts} calls failed ` +
        `(${(phase.rate * 100).toFixed(1)}%)`,
    );
  }

  return { plan, degraded };
}
