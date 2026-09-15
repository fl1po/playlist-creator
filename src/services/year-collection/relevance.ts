/**
 * Artist relevance scoring.
 *
 * Answers "how likely is this artist to be someone the user cares about",
 * combining the co-citation graph, genre/cluster affinity, and roster
 * membership. Q2 settled that the roster is a *boost*, not a gate: an artist
 * absent from trusted-artists can still outrank a P2 on graph and genre
 * evidence alone.
 *
 * This runs before any album fetching, because cutting here is what keeps the
 * Spotify bill at ~3,000 requests instead of ~12,000.
 */

import type { Cluster } from './genre-map.js';
import {
  type ArtistProfile,
  type Candidate,
  TIER_WEIGHT,
  type TasteProfile,
} from './index.js';
import { affinity, dominantCluster, modalCluster } from './profile.js';

/**
 * Component weights. Co-citation leads because it is the only signal with
 * full coverage — roughly half of all artists carry no Spotify genres, so
 * genre terms are silent for them.
 */
export const WEIGHTS = {
  coCitation: 0.45,
  genre: 0.25,
  cluster: 0.15,
  roster: 0.15,
} as const;

export interface ScoredCandidate extends Candidate {
  /** Scene used for percentile normalization downstream. */
  cluster: Cluster | null;
  /** Whether `cluster` came from seed inheritance rather than own tags. */
  clusterInherited: boolean;
  relevance: number;
  components: {
    coCitation: number;
    genre: number;
    cluster: number;
    roster: number;
  };
}

/**
 * Score one candidate.
 *
 * Co-citations are compressed logarithmically: the distribution runs from 1
 * to ~63 with 58% of candidates at exactly 1, so a linear scale would let the
 * handful of hub artists swamp every other signal.
 */
export function scoreCandidate(
  candidate: Candidate,
  profile: TasteProfile,
  maxCoCitations: number,
): ScoredCandidate {
  const genres = candidate.profile?.genres ?? [];
  const { genre, cluster: clusterAffinity } = affinity(profile, genres);

  const own = dominantCluster(genres, profile);
  const cluster = own ?? modalCluster(candidate.seedClusters);

  const coCitation =
    maxCoCitations > 1
      ? Math.log1p(candidate.coCitations) / Math.log1p(maxCoCitations)
      : candidate.coCitations > 0
        ? 1
        : 0;

  // Tier bonus normalized so P1 = 1.0 and an off-roster artist = 0.
  const tier = candidate.rosterTier;
  const roster = tier ? (TIER_WEIGHT[tier] ?? 0) / TIER_WEIGHT[1] : 0;

  const components = {
    coCitation: coCitation * WEIGHTS.coCitation,
    genre: genre * WEIGHTS.genre,
    cluster: clusterAffinity * WEIGHTS.cluster,
    roster: roster * WEIGHTS.roster,
  };

  return {
    ...candidate,
    cluster,
    clusterInherited: own === null && cluster !== null,
    relevance:
      components.coCitation +
      components.genre +
      components.cluster +
      components.roster,
    components,
  };
}

/**
 * Score a candidate pool and keep the strongest.
 *
 * Roster artists bypass the cut entirely: they are already known to matter,
 * and their releases are the spine of the result regardless of where the
 * graph happens to place them.
 */
export function scoreAndCut(
  candidates: Candidate[],
  profile: TasteProfile,
  limit: number,
): { kept: ScoredCandidate[]; dropped: ScoredCandidate[] } {
  const maxCoCitations = candidates.reduce(
    (max, c) => Math.max(max, c.coCitations),
    0,
  );

  const scored = candidates
    .map((c) => scoreCandidate(c, profile, maxCoCitations))
    .sort((a, b) => b.relevance - a.relevance);

  const kept: ScoredCandidate[] = [];
  const dropped: ScoredCandidate[] = [];

  for (const candidate of scored) {
    if (candidate.rosterTier || kept.length < limit) kept.push(candidate);
    else dropped.push(candidate);
  }

  return { kept, dropped };
}

/** Attach fetched Spotify metadata to candidates, dropping unresolvable ones. */
export function withProfiles(
  candidates: Candidate[],
  profiles: Map<string, ArtistProfile>,
): Candidate[] {
  const out: Candidate[] = [];
  for (const candidate of candidates) {
    const profile = profiles.get(candidate.spotifyId);
    if (!profile) continue;
    out.push({ ...candidate, name: profile.name, profile });
  }
  return out;
}
