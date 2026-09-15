/**
 * Year collection — build a retrospective canon of one year's releases,
 * shaped by the trusted-artists roster but not gated by it.
 *
 * Pipeline (see each module for detail):
 *
 *   profile     roster genres        → weighted genre/cluster taste vector
 *   expansion   Deezer related graph → candidate artists beyond the roster
 *   relevance   co-citation + genre  → scored artists, cut before album fetch
 *   releases    Spotify artist albums→ qualifying albums/EPs for the year
 *   acclaim     Spotify/Deezer/Last.fm → within-cluster percentile blend
 *   plan        everything above     → reviewable plan file + Markdown
 *   apply       plan                 → monthly playlists on Spotify
 *
 * The plan/apply split exists because fetching costs hours and scoring costs
 * seconds — re-scoring reads the cached plan rather than re-fetching.
 */

import type { Cluster } from './genre-map.js';

// ── Roster ──────────────────────────────────────────────────────────────────

/** One artist as scored by recalculation. */
export interface RosterArtist {
  name: string;
  spotifyId: string;
  /** 1–4, or null when below the P4 threshold. */
  priority: number | null;
  score: number;
}

/**
 * Relative pull of each priority tier, used both for weighting the taste
 * vector and for the roster-membership bonus in relevance scoring.
 * Q16 settled this: seed the graph from P1+P2, but credit all four tiers.
 */
export const TIER_WEIGHT: Record<number, number> = { 1: 4, 2: 3, 3: 2, 4: 1 };

/** Tiers used as Deezer expansion seeds. */
export const SEED_TIERS = [1, 2];

// ── Spotify artist metadata ─────────────────────────────────────────────────

export interface ArtistProfile {
  id: string;
  name: string;
  genres: string[];
  popularity: number;
  followers: number;
}

// ── Taste profile ───────────────────────────────────────────────────────────

export interface TasteProfile {
  /** Genre → weight, normalized to sum 1. */
  genreWeights: Map<string, number>;
  /** Cluster → weight, normalized to sum 1. */
  clusterWeights: Map<Cluster, number>;
  /** Spotify artist id → priority tier, for the roster bonus. */
  rosterTier: Map<string, number>;
  stats: {
    artists: number;
    tagged: number;
    distinctGenres: number;
  };
}

// ── Candidates ──────────────────────────────────────────────────────────────

export interface Candidate {
  spotifyId: string;
  name: string;
  /** How many distinct P1/P2 seeds Deezer relates to this artist. */
  coCitations: number;
  /** Clusters of the seeds that pointed here — the genre-gap fallback. */
  seedClusters: Cluster[];
  /** Present once Spotify metadata has been fetched. */
  profile?: ArtistProfile;
  /** Priority tier if this artist is on the roster. */
  rosterTier?: number;
}
