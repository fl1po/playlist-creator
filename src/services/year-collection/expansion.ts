/**
 * Candidate discovery beyond the roster.
 *
 * Spotify's `/recommendations` and `/artists/{id}/related-artists` both return
 * 404 for apps registered after November 2024, so the taste graph comes from
 * Deezer instead. Every P1/P2 artist is resolved to a Deezer id and its
 * related artists collected; an artist's *co-citation count* — how many
 * distinct seeds point at them — is the primary relevance signal.
 *
 * Deezer's graph reflects present-day co-listening, so it under-reaches
 * artists who mattered in the target year and then faded. `collaborators` is
 * meant to correct for that using the featured credits on releases actually
 * found in that year, an era-anchored snapshot of who was in the scene — but
 * `collectYear` does not call it yet.
 */

import type { DeezerClient } from '../../lib/deezer-client.js';
import type { Cluster } from './genre-map.js';
import type { Candidate, RosterArtist } from './index.js';

export interface ExpansionProgress {
  onSeedResolved?: (done: number, total: number, name: string) => void;
  onSeedUnresolved?: (name: string) => void;
  checkAbort?: () => void;
}

/** An artist discovered by the graph, keyed by lowercased name. */
interface RawCandidate {
  name: string;
  coCitations: number;
  seedClusters: Cluster[];
  deezerId: number;
}

/**
 * Expand outward from the seed artists.
 *
 * Returns candidates keyed by lowercased name — Spotify ids are not known
 * yet, since resolving ~4,300 names against Spotify at one request per second
 * would cost over an hour. Callers cut on co-citation first, then resolve only
 * the survivors (the resolution step in `collectYear`, run.ts).
 */
export async function expandFromSeeds(
  client: DeezerClient,
  seeds: RosterArtist[],
  seedCluster: (seed: RosterArtist) => Cluster | null,
  progress?: ExpansionProgress,
): Promise<{
  candidates: Map<string, RawCandidate>;
  /**
   * Seed Spotify id → lowercased names of its related artists.
   *
   * Kept because ~47% of the roster carries no Spotify genres, and a seed's
   * neighbourhood is the only cluster signal those artists have. Resolving it
   * costs nothing extra — the lists are already fetched here.
   */
  seedRelations: Map<string, string[]>;
}> {
  const candidates = new Map<string, RawCandidate>();
  const seedRelations = new Map<string, string[]>();
  let done = 0;

  for (const seed of seeds) {
    progress?.checkAbort?.();

    const artist = await client.searchArtist(seed.name);
    if (!artist) {
      progress?.onSeedUnresolved?.(seed.name);
      done++;
      progress?.onSeedResolved?.(done, seeds.length, seed.name);
      continue;
    }

    const related = await client.relatedArtists(artist.id);
    const cluster = seedCluster(seed);
    seedRelations.set(
      seed.spotifyId,
      related.map((n) => n.name.toLowerCase().trim()),
    );

    for (const neighbour of related) {
      const key = neighbour.name.toLowerCase().trim();
      const existing = candidates.get(key);
      if (existing) {
        existing.coCitations++;
        if (cluster) existing.seedClusters.push(cluster);
      } else {
        candidates.set(key, {
          name: neighbour.name,
          coCitations: 1,
          seedClusters: cluster ? [cluster] : [],
          deezerId: neighbour.id,
        });
      }
    }

    done++;
    progress?.onSeedResolved?.(done, seeds.length, seed.name);
  }

  return { candidates, seedRelations };
}

/**
 * Harvest featured artists off releases found in the target year.
 *
 * Unlike the Deezer graph this is anchored in the year itself: a 2016 feature
 * list records who was actually working with whom in 2016, which reaches
 * artists whose present-day similarity edges have decayed to nothing.
 */
export function collaborators(
  releaseArtists: Array<{ artists: Array<{ id: string; name: string }> }>,
  known: Set<string>,
): Map<string, { id: string; name: string; coCitations: number }> {
  const found = new Map<
    string,
    { id: string; name: string; coCitations: number }
  >();

  for (const release of releaseArtists) {
    for (const artist of release.artists) {
      if (known.has(artist.id)) continue;
      const existing = found.get(artist.id);
      if (existing) existing.coCitations++;
      else
        found.set(artist.id, {
          id: artist.id,
          name: artist.name,
          coCitations: 1,
        });
    }
  }

  return found;
}

/**
 * Drop candidates below a co-citation threshold.
 *
 * A single citation means one artist out of 941 seeds has an edge to them,
 * which is barely evidence and is where the bulk of the graph's noise lives.
 * Cutting here is what keeps the Spotify resolution step affordable.
 */
export function cutByCoCitation(
  candidates: Map<string, RawCandidate>,
  minCoCitations: number,
): RawCandidate[] {
  return [...candidates.values()]
    .filter((c) => c.coCitations >= minCoCitations)
    .sort((a, b) => b.coCitations - a.coCitations);
}

export type { RawCandidate };
export type { Candidate };
