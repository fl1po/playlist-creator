import type { FoundRelease } from "../lib/types.js";
import { acousticPattern, cleanPattern, instrumentalPattern, instrumentalTrackPattern, slowedPattern, spedUpPattern } from "./filters.js";

const deluxePatterns = [
  /\bdeluxe\b/i,
  /\bexpanded\b/i,
  /\bbonus\b/i,
  /\bcomplete\b.*\bedition\b/i,
  /\bultimate\b.*\bedition\b/i,
  /\bsuper\b.*\bedition\b/i,
  /\bplatinum\b.*\bedition\b/i,
  /\banniversary\b.*\bedition\b/i,
];

export function isDeluxeRelease(albumName: string): boolean {
  return deluxePatterns.some((p) => p.test(albumName));
}

export function getBaseAlbumName(albumName: string): string {
  return albumName
    .replace(
      /\s*[\(\[].*?(deluxe|expanded|bonus|complete|ultimate|super|platinum|anniversary).*?[\)\]]/gi,
      "",
    )
    .replace(
      /\s*-\s*(deluxe|expanded|bonus|complete|ultimate|super|platinum).*$/gi,
      "",
    )
    .replace(
      /\s+(deluxe|expanded|bonus|complete|ultimate|super|platinum)\s*(edition|version)?$/gi,
      "",
    )
    .trim();
}

/**
 * Pick which variants to drop. Sped-up/slowed releases are always dropped;
 * instrumental/clean/acoustic ones only when a release with the stripped base
 * name exists in the same set. Returns the IDs to exclude (`filtered`) plus
 * the reason for each, for collection decisions.
 */
export function filterVariants(
  releases: Map<string, FoundRelease>,
): { filtered: Set<string>; removed: Array<{ id: string; type: string; release: FoundRelease }> } {
  const removed: Array<{ id: string; type: string; release: FoundRelease }> = [];

  for (const [id, release] of releases) {
    const name = release.name;
    const isInstrumental = instrumentalPattern.test(name);
    const isClean = cleanPattern.test(name);
    const isAcoustic = acousticPattern.test(name);
    const isSpedUp = spedUpPattern.test(name);
    const isSlowed = slowedPattern.test(name);
    if (!isInstrumental && !isClean && !isAcoustic && !isSpedUp && !isSlowed) continue;

    if (isSpedUp || isSlowed) {
      removed.push({
        id,
        type: isSpedUp ? "sped up" : "slowed",
        release,
      });
      continue;
    }

    const baseName = name
      .replace(instrumentalPattern, "")
      .replace(cleanPattern, "")
      .replace(acousticPattern, "")
      .trim()
      .toLowerCase();

    for (const [otherId, other] of releases) {
      if (otherId === id) continue;
      if (other.name.toLowerCase().trim() === baseName) {
        removed.push({
          id,
          type: isInstrumental ? "instrumental" : isAcoustic ? "acoustic" : "clean",
          release,
        });
        break;
      }
    }
  }

  const filtered = new Set(removed.map((r) => r.id));
  return { filtered, removed };
}

/** True when every track is an instrumental; an empty list is not. */
export function isAllInstrumental(
  tracks: Array<{ name: string }>,
): boolean {
  if (tracks.length === 0) return false;
  return tracks.every((t) => instrumentalTrackPattern.test(t.name));
}

export interface RawRelease {
  id: string;
  name: string;
  type: string;
  release_date: string;
  artistId: string;
  markets: number;
}

/** Group releases by normalized name + date + type, for dedup. */
export function groupReleases(
  releases: RawRelease[],
): Map<string, RawRelease[]> {
  const groups = new Map<string, RawRelease[]>();
  for (const release of releases) {
    const key = `${release.name.toLowerCase().trim()}|${release.release_date}|${release.type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(release);
  }
  return groups;
}

/** Check if a release date could overlap with valid dates. Spotify returns
 *  `YYYY-MM` or `YYYY` when release_date_precision is month/year.
 *  Day-precision → exact match. Month/year → any valid date shares that prefix. */
export function releaseDateCouldMatch(releaseDate: string, validDates: string[]): boolean {
  if (releaseDate.length === 10) return validDates.includes(releaseDate);
  return validDates.some(d => d.startsWith(releaseDate));
}

/** Last-resort match for imprecise dates when full album lookup fails.
 *  Month-precision → last day of month; year-precision → Dec 31. */
export function releaseDateFallbackMatch(releaseDate: string, validDates: string[]): boolean {
  if (releaseDate.length === 7) {
    const [y, m] = releaseDate.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    return validDates.includes(`${releaseDate}-${String(lastDay).padStart(2, "0")}`);
  }
  return validDates.includes(`${releaseDate}-12-31`);
}

/** IDs below `threshold`. Releases with no known popularity are kept. */
export function filterLowPopularity(
  releases: Map<string, FoundRelease>,
  popularities: Map<string, number>,
  threshold = 10,
): Set<string> {
  const lowPop = new Set<string>();
  for (const [id] of releases) {
    const popularity = popularities.get(id);
    if (popularity !== undefined && popularity < threshold) {
      lowPop.add(id);
    }
  }
  return lowPop;
}
