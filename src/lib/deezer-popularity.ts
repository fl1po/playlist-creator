/**
 * Fetches release popularity from Deezer as a replacement for Spotify's
 * album popularity scores. Uses Deezer's track `rank` field (0–1,000,000)
 * normalized to a 0–100 scale to match the existing threshold logic.
 */

import { DeezerClient } from './deezer-client.js';
import type { FoundRelease } from './types.js';

export interface DeezerPopularityOptions {
  onProgress?: (done: number, total: number) => void;
  onNotFound?: (artistName: string, releaseName: string) => void;
  /** Cooperative cancellation — throws to abort. Called before each release lookup. */
  checkAbort?: () => void;
}

/**
 * Normalize a string for fuzzy comparison:
 * lowercase, strip feat/with info, strip edition suffixes, remove punctuation.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s*[\(\[].*?[\)\]]\s*/g, '') // remove (Deluxe), [feat. X], etc.
    .replace(/['']/g, "'")
    .replace(/[^\w\s']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if two strings match after normalization.
 */
function fuzzyMatch(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Fetch popularity scores from Deezer for a set of releases.
 * Returns a Map of release ID → normalized popularity (0–100).
 *
 * Releases not found on Deezer are omitted from the map (they'll pass
 * through filterLowPopularity unchanged).
 */
export async function fetchDeezerPopularities(
  releases: Map<string, FoundRelease>,
  options?: DeezerPopularityOptions,
): Promise<Map<string, number>> {
  const client = new DeezerClient();
  const popularities = new Map<string, number>();
  const entries = [...releases.entries()];
  let done = 0;

  for (const [id, release] of entries) {
    options?.checkAbort?.();
    const query = `${release.artistName} ${release.name}`;
    const results = await client.searchAlbum(query);

    // Best match: artist + title. When that fails, fall back to an exact
    // (normalized) title match — Deezer often credits a release to its primary
    // artist while we look it up under a featured/secondary artist (e.g. a
    // track collected via "Ebenezer" but credited to "Vijay Aaron" on Deezer).
    // Without this, such releases slip through unmatched and dodge the gate.
    let match = results.find(
      (r) =>
        fuzzyMatch(r.artist.name, release.artistName) &&
        fuzzyMatch(r.title, release.name),
    );
    if (!match) {
      match = results.find(
        (r) => normalize(r.title) === normalize(release.name),
      );
    }

    if (!match) {
      options?.onNotFound?.(release.artistName, release.name);
      done++;
      options?.onProgress?.(done, entries.length);
      continue;
    }

    // Fetch full album to get track ranks
    const album = await client.getAlbum(match.id);
    if (!album?.tracks?.data?.length) {
      done++;
      options?.onProgress?.(done, entries.length);
      continue;
    }

    // Use max track rank as the album's popularity signal
    const maxRank = Math.max(...album.tracks.data.map((t) => t.rank));
    // Normalize: Deezer 0–1,000,000 → 0–100
    const normalized = Math.round(maxRank / 10_000);
    popularities.set(id, normalized);

    done++;
    options?.onProgress?.(done, entries.length);
  }

  options?.onProgress?.(entries.length, entries.length);
  return popularities;
}
