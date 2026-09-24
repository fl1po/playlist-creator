/**
 * Acclaim scoring.
 *
 * Three sources, two axes. Spotify popularity and Deezer track rank measure
 * *endurance* — what people stream today. Last.fm playcount is cumulative and
 * its userbase skews album-oriented, so it stands in for critical standing.
 *
 * Everything is converted to a percentile **within the release's own genre
 * cluster** before blending. Raw scores would let the mainstream bury the
 * underground: in 2016 Drake's *Views* scores 89 on Spotify against Skepta's
 * *Konnichiwa* at 65 and Kano's *Made in the Manor* at 53, so a global sort
 * puts every grime landmark below any mainstream rap record.
 *
 * The Last.fm sample-size floor is not a nicety. Median listeners by cluster:
 * critic ~688,000, uk ~217,000, **afro ~3,400** — with individual Afro
 * records at 67 and 69 listeners. At that scale a percentile measures which
 * record a handful of Western scrobblers happened to touch, not quality. So
 * below `MIN_LASTFM_LISTENERS` the signal is treated as *absent* rather than
 * as low, and the release is scored on streaming alone at full weight.
 */

import type { DeezerClient } from '../../lib/deezer-client.js';
import type { LastfmClient } from '../../lib/lastfm-client.js';
import type { SpotifyContext } from '../../lib/spotify-context.js';
import type { PhaseReporter } from './checkpoint.js';
import type { Cluster } from './genre-map.js';
import type { YearRelease } from './releases.js';

/** Blend weights, settled in Q8: critic-led. */
export const STREAMING_WEIGHT = 0.35;
export const CRITIC_WEIGHT = 0.65;

/** Below this many Last.fm listeners the critic signal is noise, not data. */
export const MIN_LASTFM_LISTENERS = 5_000;

/** Releases below this percentile within their own cluster are cut. */
export const FLOOR_PERCENTILE = 0.25;

/** Spotify's cap on the batched albums endpoint. */
const ALBUM_BATCH = 20;

export interface AcclaimSignals {
  spotifyPopularity: number | null;
  deezerPopularity: number | null;
  lastfmPlaycount: number | null;
  lastfmListeners: number | null;
  /** True when Last.fm had data but too little of it to trust. */
  lastfmBelowFloor: boolean;
}

export interface ScoredRelease extends YearRelease {
  cluster: Cluster;
  signals: AcclaimSignals;
  /** Percentiles within cluster, 0–1. */
  percentiles: {
    streaming: number;
    critic: number | null;
  };
  /** Final blended acclaim, 0–1. */
  acclaim: number;
  /** True when scored on streaming alone because Last.fm had no usable data. */
  criticFallback: boolean;
}

// ── Signal collection ───────────────────────────────────────────────────────

/** Spotify album popularity, 20 albums per request. */
export async function fetchSpotifyPopularity(
  ctx: SpotifyContext,
  releaseIds: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(releaseIds)];

  for (let i = 0; i < unique.length; i += ALBUM_BATCH) {
    const batch = unique.slice(i, i + ALBUM_BATCH);
    const result = await ctx.call(
      () => ctx.api.albums.get(batch),
      `album popularity batch ${i / ALBUM_BATCH + 1}`,
    );
    if (!result.success) {
      if (result.authError) throw result.error;
    } else {
      for (const album of result.data) {
        if (album) out.set(album.id, album.popularity ?? 0);
      }
    }
    onProgress?.(Math.min(i + ALBUM_BATCH, unique.length), unique.length);
  }

  return out;
}

/**
 * Deezer track rank for each release, normalized 0–100.
 *
 * Mirrors `fetchDeezerPopularities` but keyed on our release ids. Deezer
 * compresses the mainstream gap that Spotify exaggerates, which is why it is
 * worth the extra lookups.
 */
export async function fetchDeezerAcclaim(
  client: DeezerClient,
  releases: YearRelease[],
  onProgress?: (done: number, total: number) => void,
  checkAbort?: () => void,
  report?: PhaseReporter,
  /** Already-fetched results, so a resumed run skips them. */
  seed?: Map<string, number>,
  onFlush?: (partial: Map<string, number>, done: number) => void,
): Promise<Map<string, number>> {
  const out = new Map(seed ?? []);
  let done = 0;

  for (const release of releases) {
    checkAbort?.();
    if (out.has(release.id)) {
      done++;
      onProgress?.(done, releases.length);
      continue;
    }
    report?.attempt();
    const results = await client.searchAlbum(
      `${release.artistName} ${release.name}`,
    );
    const match =
      results.find(
        (r) =>
          normalize(r.artist.name) === normalize(release.artistName) &&
          normalize(r.title) === normalize(release.name),
      ) ?? results.find((r) => normalize(r.title) === normalize(release.name));

    if (match) {
      const album = await client.getAlbum(match.id);
      const ranks = album?.tracks?.data?.map((t) => t.rank) ?? [];
      if (ranks.length) {
        out.set(release.id, Math.round(Math.max(...ranks) / 10_000));
      } else {
        report?.fail();
      }
    } else {
      // Ambiguous: either genuinely absent from Deezer, or the service is
      // down. A single miss is normal; a high rate is the outage signature.
      report?.fail();
    }

    done++;
    onProgress?.(done, releases.length);
    if (done % 100 === 0) onFlush?.(out, done);
  }

  return out;
}

/** Last.fm listeners and playcount per release. */
export async function fetchLastfmAcclaim(
  client: LastfmClient,
  releases: YearRelease[],
  onProgress?: (done: number, total: number) => void,
  checkAbort?: () => void,
  report?: PhaseReporter,
  /** Already-fetched results, so a resumed run skips them. */
  seed?: Map<string, { listeners: number; playcount: number }>,
  onFlush?: (
    partial: Map<string, { listeners: number; playcount: number }>,
    done: number,
  ) => void,
): Promise<Map<string, { listeners: number; playcount: number }>> {
  const out = new Map(seed ?? []);
  let done = 0;

  for (const release of releases) {
    checkAbort?.();
    if (out.has(release.id)) {
      done++;
      onProgress?.(done, releases.length);
      continue;
    }
    report?.attempt();
    const info = await client.albumInfo(release.artistName, release.name);
    if (info) {
      out.set(release.id, {
        listeners: info.listeners,
        playcount: info.playcount,
      });
    } else {
      report?.fail();
    }
    done++;
    onProgress?.(done, releases.length);
    if (done % 100 === 0) onFlush?.(out, done);
  }

  return out;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s*[\(\[].*?[\)\]]\s*/g, '')
    .replace(/[^\w\s']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Percentile of each value within its own list: the fraction of entries
 * strictly below it, normalized so the weakest scores 0 and the strongest 1
 * (a lone value also scores 1). Ties share a percentile rather than being
 * ordered arbitrarily.
 */
function percentiles(values: number[]): Map<number, number> {
  const sorted = [...values].sort((a, b) => a - b);
  const out = new Map<number, number>();
  for (const value of sorted) {
    if (out.has(value)) continue;
    const below = sorted.filter((v) => v < value).length;
    out.set(value, sorted.length > 1 ? below / (sorted.length - 1) : 1);
  }
  return out;
}

/**
 * Blend all signals into a per-release acclaim score.
 *
 * Percentiles are computed per cluster, so a release only ever competes with
 * others from its own scene.
 */
export function scoreAcclaim(
  releases: Array<YearRelease & { cluster: Cluster }>,
  spotify: Map<string, number>,
  deezer: Map<string, number>,
  lastfm: Map<string, { listeners: number; playcount: number }>,
): ScoredRelease[] {
  const byCluster = new Map<
    Cluster,
    Array<YearRelease & { cluster: Cluster }>
  >();
  for (const release of releases) {
    const group = byCluster.get(release.cluster);
    if (group) group.push(release);
    else byCluster.set(release.cluster, [release]);
  }

  const scored: ScoredRelease[] = [];

  for (const [cluster, group] of byCluster) {
    // Streaming: mean of whichever of Spotify/Deezer are present.
    const streamingRaw = new Map<string, number>();
    for (const release of group) {
      const parts: number[] = [];
      const sp = spotify.get(release.id);
      const dz = deezer.get(release.id);
      if (sp !== undefined) parts.push(sp);
      if (dz !== undefined) parts.push(dz);
      streamingRaw.set(
        release.id,
        parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0,
      );
    }

    // Critic: only releases clearing the sample-size floor take part, so a
    // thin cluster's percentiles are computed over real data or not at all.
    const criticRaw = new Map<string, number>();
    for (const release of group) {
      const info = lastfm.get(release.id);
      if (info && info.listeners >= MIN_LASTFM_LISTENERS) {
        criticRaw.set(release.id, info.playcount);
      }
    }

    const streamingPct = percentiles([...streamingRaw.values()]);
    const criticPct = percentiles([...criticRaw.values()]);

    for (const release of group) {
      const info = lastfm.get(release.id);
      const streaming =
        streamingPct.get(streamingRaw.get(release.id) ?? 0) ?? 0;
      const criticValue = criticRaw.get(release.id);
      const critic =
        criticValue === undefined ? null : (criticPct.get(criticValue) ?? 0);

      const acclaim =
        critic === null
          ? streaming
          : STREAMING_WEIGHT * streaming + CRITIC_WEIGHT * critic;

      scored.push({
        ...release,
        cluster,
        signals: {
          spotifyPopularity: spotify.get(release.id) ?? null,
          deezerPopularity: deezer.get(release.id) ?? null,
          lastfmPlaycount: info?.playcount ?? null,
          lastfmListeners: info?.listeners ?? null,
          lastfmBelowFloor:
            info !== undefined && info.listeners < MIN_LASTFM_LISTENERS,
        },
        percentiles: { streaming, critic },
        acclaim,
        criticFallback: critic === null,
      });
    }
  }

  return scored;
}

/**
 * Apply the acclaim floor.
 *
 * Q12: nothing is cut to hit a track target, but a release must clear the
 * bottom quartile of its own cluster. "Weak for its scene" is a defensible
 * reason to exclude; "we needed to stop at 1,000 tracks" is not.
 */
export function applyFloor(
  releases: ScoredRelease[],
  floorPercentile = FLOOR_PERCENTILE,
): { kept: ScoredRelease[]; cut: ScoredRelease[] } {
  const kept: ScoredRelease[] = [];
  const cut: ScoredRelease[] = [];

  const byCluster = new Map<Cluster, ScoredRelease[]>();
  for (const release of releases) {
    const group = byCluster.get(release.cluster);
    if (group) group.push(release);
    else byCluster.set(release.cluster, [release]);
  }

  for (const [, group] of byCluster) {
    // A cluster too small for a meaningful quartile keeps everything.
    if (group.length < 8) {
      kept.push(...group);
      continue;
    }
    const sorted = [...group].sort((a, b) => a.acclaim - b.acclaim);
    const cutoff = Math.floor(sorted.length * floorPercentile);
    sorted.forEach((release, i) => {
      if (i < cutoff) cut.push(release);
      else kept.push(release);
    });
  }

  return { kept, cut };
}
