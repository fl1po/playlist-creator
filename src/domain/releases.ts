import type { FoundRelease } from "../lib/types.js";
import { acousticPattern, cleanPattern, instrumentalPattern, instrumentalTrackPattern } from "./filters.js";

// ── Deluxe detection ────────────────────────────────────────────────────────

const deluxePatterns = [
  /\bdeluxe\b/i,
  /\bexpanded\b/i,
  /\bbonus\b/i,
  /\bcomplete\b.*\bedition\b/i,
  /\bultimate\b.*\bedition\b/i,
  /\bsuper\b.*\bedition\b/i,
  /\bplatinum\b.*\bedition\b/i,
  /\banniversary\b/i,
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

// ── Variant filtering ───────────────────────────────────────────────────────

/** Filter out instrumental/clean versions when the original/explicit exists. */
export function filterVariants(
  releases: Map<string, FoundRelease>,
): { filtered: Set<string>; removed: Array<{ id: string; type: string; release: FoundRelease }> } {
  const removed: Array<{ id: string; type: string; release: FoundRelease }> = [];

  for (const [id, release] of releases) {
    const name = release.name;
    const isInstrumental = instrumentalPattern.test(name);
    const isClean = cleanPattern.test(name);
    const isAcoustic = acousticPattern.test(name);
    if (!isInstrumental && !isClean && !isAcoustic) continue;

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

/** Check if all tracks in a list are instrumental. */
export function isAllInstrumental(
  tracks: Array<{ name: string }>,
): boolean {
  if (tracks.length === 0) return false;
  return tracks.every((t) => instrumentalTrackPattern.test(t.name));
}

// ── Release grouping (pick best version) ────────────────────────────────────

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

// ── Popularity filtering ────────────────────────────────────────────────────

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
