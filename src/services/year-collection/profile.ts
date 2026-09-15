/**
 * Taste profile construction.
 *
 * Turns the trusted-artists roster into a weighted genre vector and cluster
 * distribution. Roughly half the roster carries no Spotify genre tags at all,
 * so the vector describes the tagged half and the co-citation graph carries
 * the rest — see relevance.ts.
 */

import type { SpotifyContext } from '../../lib/spotify-context.js';
import type { TrustedArtistsFile } from '../../lib/types.js';
import type { PhaseReporter } from './checkpoint.js';
import { type Cluster, clusterOf } from './genre-map.js';
import {
  type ArtistProfile,
  type RosterArtist,
  TIER_WEIGHT,
  type TasteProfile,
} from './index.js';

/** Spotify's cap on the batched artist endpoint. */
const ARTIST_BATCH = 50;

/** Flatten a trusted-artists file into the roster entries we can act on. */
export function toRoster(file: TrustedArtistsFile): RosterArtist[] {
  const roster: RosterArtist[] = [];
  for (const [name, counts] of Object.entries(file.artistCounts)) {
    if (!counts.spotifyId) continue;
    roster.push({
      name,
      spotifyId: counts.spotifyId,
      priority: counts.priority ?? null,
      score: counts.score ?? 0,
    });
  }
  return roster;
}

/**
 * Batch-fetch Spotify artist metadata. 50 ids per call, so the whole roster
 * costs ~69 requests rather than 3,447.
 *
 * Artists Spotify cannot resolve are simply absent from the result.
 */
export async function fetchArtistProfiles(
  ctx: SpotifyContext,
  ids: string[],
  onProgress?: (done: number, total: number) => void,
  report?: PhaseReporter,
): Promise<Map<string, ArtistProfile>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, ArtistProfile>();

  for (let i = 0; i < unique.length; i += ARTIST_BATCH) {
    const batch = unique.slice(i, i + ARTIST_BATCH);
    report?.attempt(batch.length);
    const result = await ctx.call(
      () => ctx.api.artists.get(batch),
      `artist metadata batch ${i / ARTIST_BATCH + 1}`,
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      // A dropped batch costs 50 artists their genres, which silently moves
      // them into the wrong cluster — count it rather than shrugging.
      report?.fail(batch.length);
      onProgress?.(Math.min(i + ARTIST_BATCH, unique.length), unique.length);
      continue;
    }

    for (const artist of result.data) {
      if (!artist) continue;
      out.set(artist.id, {
        id: artist.id,
        name: artist.name,
        genres: artist.genres ?? [],
        popularity: artist.popularity ?? 0,
        followers: artist.followers?.total ?? 0,
      });
    }

    onProgress?.(Math.min(i + ARTIST_BATCH, unique.length), unique.length);
  }

  return out;
}

/**
 * Build the weighted taste vector.
 *
 * Each artist contributes their tier weight to every genre they carry, so a
 * P1 artist pulls four times as hard as a P4. Weights are normalized to sum
 * to 1 so downstream affinity scores are comparable across runs.
 */
export function buildTasteProfile(
  roster: RosterArtist[],
  profiles: Map<string, ArtistProfile>,
): TasteProfile {
  const rawGenre = new Map<string, number>();
  const rawCluster = new Map<Cluster, number>();
  const rosterTier = new Map<string, number>();
  let tagged = 0;

  for (const artist of roster) {
    if (artist.priority) rosterTier.set(artist.spotifyId, artist.priority);

    const profile = profiles.get(artist.spotifyId);
    if (!profile || profile.genres.length === 0) continue;
    tagged++;

    const weight = TIER_WEIGHT[artist.priority ?? 4] ?? 1;
    for (const genre of profile.genres) {
      const key = genre.toLowerCase().trim();
      rawGenre.set(key, (rawGenre.get(key) ?? 0) + weight);
      const cluster = clusterOf(key);
      rawCluster.set(cluster, (rawCluster.get(cluster) ?? 0) + weight);
    }
  }

  return {
    genreWeights: normalize(rawGenre),
    clusterWeights: normalize(rawCluster),
    rosterTier,
    stats: {
      artists: roster.length,
      tagged,
      distinctGenres: rawGenre.size,
    },
  };
}

function normalize<K>(raw: Map<K, number>): Map<K, number> {
  const total = [...raw.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return new Map();
  const out = new Map<K, number>();
  for (const [key, value] of raw) out.set(key, value / total);
  return out;
}

/**
 * How strongly a set of genres sits inside the profile, on two grains.
 *
 * `genre` is fine but sparse — it only fires on exact tag matches, and sums
 * across distinct tags because matching three profile genres really is
 * stronger evidence than matching one.
 *
 * `cluster` is coarse but robust, and survives an artist tagged with an
 * adjacent micro-genre the roster happens not to use. It takes the *strongest
 * single* scene rather than summing: an artist spanning afro, rap and pop is
 * not three times as relevant as one squarely inside your biggest scene, and
 * summing would rank genre-spanning generalists above specialists in exactly
 * the scenes you care most about.
 */
export function affinity(
  profile: TasteProfile,
  genres: string[],
): { genre: number; cluster: number } {
  if (genres.length === 0) return { genre: 0, cluster: 0 };

  const seenGenres = new Set<string>();
  let genreScore = 0;
  let clusterScore = 0;

  for (const raw of genres) {
    const key = raw.toLowerCase().trim();
    if (seenGenres.has(key)) continue;
    seenGenres.add(key);
    genreScore += profile.genreWeights.get(key) ?? 0;
    const weight = profile.clusterWeights.get(clusterOf(key)) ?? 0;
    if (weight > clusterScore) clusterScore = weight;
  }

  return { genre: genreScore, cluster: clusterScore };
}

/**
 * The scene a set of genres belongs to, for percentile normalization.
 *
 * Modal cluster across the artist's tags, so assignment is a property of the
 * artist rather than of the profile — using profile weight here would drag
 * every multi-scene artist into whichever cluster the user likes most and
 * distort the percentile pools. Ties break on profile weight.
 *
 * Returns null for untagged artists; callers fall back to seed clusters.
 */
export function dominantCluster(
  genres: string[],
  profile: TasteProfile,
): Cluster | null {
  if (genres.length === 0) return null;

  const counts = new Map<Cluster, number>();
  for (const genre of genres) {
    const cluster = clusterOf(genre);
    counts.set(cluster, (counts.get(cluster) ?? 0) + 1);
  }

  let best: Cluster | null = null;
  let bestCount = -1;
  let bestWeight = -1;
  for (const [cluster, count] of counts) {
    const weight = profile.clusterWeights.get(cluster) ?? 0;
    if (count > bestCount || (count === bestCount && weight > bestWeight)) {
      best = cluster;
      bestCount = count;
      bestWeight = weight;
    }
  }
  return best;
}

/** Modal cluster of the seeds that co-cited an artist — the untagged fallback. */
export function modalCluster(clusters: Cluster[]): Cluster | null {
  if (clusters.length === 0) return null;
  const counts = new Map<Cluster, number>();
  for (const cluster of clusters) {
    counts.set(cluster, (counts.get(cluster) ?? 0) + 1);
  }
  let best: Cluster | null = null;
  let bestCount = -1;
  for (const [cluster, count] of counts) {
    if (count > bestCount) {
      best = cluster;
      bestCount = count;
    }
  }
  return best;
}
