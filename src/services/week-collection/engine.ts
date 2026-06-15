import {
  type RawRelease,
  getBaseAlbumName,
  groupReleases,
  isAllInstrumental,
  isDeluxeRelease,
  releaseDateCouldMatch,
  releaseDateFallbackMatch,
} from '../../domain/releases.js';
import type { FoundRelease } from '../../lib/types.js';
import type {
  CollectionDecision,
  RawAlbum,
  ReleaseReads,
  WeekProgressEvent,
} from './index.js';

/**
 * The shared release-discovery + track-collection engine behind `ReleaseReads`.
 *
 * Two consumers drive it: `collectWeek` (one Friday's window, editorial,
 * checkpoints) and `syncPriorityChanges` (per-playlist promotion backfill). The
 * engine owns no orchestration — callers build a `Run`, feed it found releases,
 * and read decisions back off `run.decisions`.
 */
export interface Run {
  reads: ReleaseReads;
  decisions: CollectionDecision[];
  onProgress?: (e: WeekProgressEvent) => void;
  /** artistAlbums responses memoized for the lifetime of one run. */
  albumsByArtist: Map<string, RawAlbum[]>;
}

export interface Collected {
  release: FoundRelease;
  trackIds: string[];
}

// ── Artist release discovery ─────────────────────────────────────────────────

async function memoArtistAlbums(run: Run, artistId: string) {
  const cached = run.albumsByArtist.get(artistId);
  if (cached) return cached;
  const albums = await run.reads.artistAlbums(artistId);
  run.albumsByArtist.set(artistId, albums);
  return albums;
}

/** Window-filter an artist's releases, then keep one variant per group. */
export async function getArtistWindowReleases(
  run: Run,
  artistId: string,
  validDates: string[],
): Promise<Array<RawRelease & { markets: number }>> {
  const albums = await memoArtistAlbums(run, artistId);
  const inWindow: Array<RawRelease & { markets: number }> = [];

  for (const album of albums) {
    let releaseDate = album.release_date;
    if (releaseDate.length === 10) {
      if (!validDates.includes(releaseDate)) continue;
    } else if (releaseDateCouldMatch(releaseDate, validDates)) {
      const full = await run.reads.albumDetails(album.id);
      if (full && full.release_date.length === 10) {
        releaseDate = full.release_date;
        if (!validDates.includes(releaseDate)) continue;
      } else if (!releaseDateFallbackMatch(releaseDate, validDates)) {
        continue;
      }
    } else {
      continue;
    }
    inWindow.push({
      id: album.id,
      name: album.name,
      type: album.type,
      release_date: releaseDate,
      artistId,
      markets: album.markets,
    });
  }

  // Same-release duplicates: keep the explicit / widest-market variant.
  const groups = groupReleases(inWindow);
  const releases: Array<RawRelease & { markets: number }> = [];
  for (const [, group] of groups) {
    if (group.length === 1) {
      releases.push(group[0] as RawRelease & { markets: number });
      continue;
    }
    let best = group[0];
    let bestIsExplicit = false;
    let bestMarkets = group[0].markets;
    for (const release of group) {
      const info = await run.reads.albumDetails(release.id);
      if (!info) continue;
      if (info.explicit && !bestIsExplicit) {
        best = release;
        bestIsExplicit = true;
        bestMarkets = info.markets;
      } else if (
        info.explicit === bestIsExplicit &&
        info.markets > bestMarkets
      ) {
        best = release;
        bestMarkets = info.markets;
      }
    }
    releases.push(best as RawRelease & { markets: number });
    run.decisions.push({
      kind: 'variant-picked',
      release: best.name,
      variantCount: group.length,
      explicit: bestIsExplicit,
    });
  }
  return releases;
}

// ── Track collection ─────────────────────────────────────────────────────────

/**
 * Collect playable track ids for the given releases, applying deluxe,
 * title-track-only, and album/single dedup rules. `exclude` holds track ids
 * removed outright (the listening history for a week collection; the All Weekly
 * ids plus the playlist's existing tracks for a promotion sync).
 */
export async function collectTracks(
  run: Run,
  foundReleases: Map<string, FoundRelease>,
  exclude: Set<string>,
): Promise<{ collected: Collected[]; skippedCount: number }> {
  const collected: Collected[] = [];
  let skippedCount = 0;
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const previousKeysByArtist = new Map<string, Set<string>>();

  // Albums first, so singles dedup against their album versions.
  const sorted = [...foundReleases.entries()].sort((a, b) => {
    if (a[1].type === 'album' && b[1].type !== 'album') return -1;
    if (a[1].type !== 'album' && b[1].type === 'album') return 1;
    return 0;
  });

  let done = 0;
  for (const [albumId, release] of sorted) {
    run.onProgress?.({
      phase: 'collecting',
      done,
      total: sorted.length,
      release: release.name,
    });
    done++;
    const albumTracks = await run.reads.albumTracks(albumId);

    if (albumTracks.length > 0 && isAllInstrumental(albumTracks)) {
      run.decisions.push({
        kind: 'variant-stripped',
        reason: 'all-instrumental',
        artist: release.artistName,
        release: release.name,
      });
      continue;
    }

    // Deluxe release: only tracks absent from the base album qualify.
    let originalTrackKeys: Set<string> | null = null;
    if (isDeluxeRelease(release.name)) {
      const baseName = getBaseAlbumName(release.name);
      originalTrackKeys = await getOriginalAlbumTrackKeys(
        run,
        release.artistSpotifyId,
        baseName,
      );
      if (originalTrackKeys.size > 0) {
        run.decisions.push({
          kind: 'deluxe-stripped',
          release: release.name,
          baseName,
          originalTrackCount: originalTrackKeys.size,
          bonusTracks: 0,
        });
      }
    }

    // Title-track-only: single promotion disguised as an album.
    let titleTrackOnly: string | null = null;
    if (albumTracks.length > 1) {
      const titleTrack = albumTracks.find(
        (t) => t.name.toLowerCase() === release.name.toLowerCase(),
      );
      if (titleTrack) {
        const previousKeys = await getArtistPreviousTrackKeys(
          run,
          release.artistSpotifyId,
          release.release_date,
          previousKeysByArtist,
        );
        if (previousKeys.size > 0) {
          const otherTracks = albumTracks.filter((t) => t.id !== titleTrack.id);
          const oldCount = otherTracks.filter((t) =>
            previousKeys.has(t.key),
          ).length;
          if (oldCount > otherTracks.length / 2) {
            titleTrackOnly = titleTrack.id;
            run.decisions.push({
              kind: 'title-track-only',
              release: release.name,
              track: titleTrack.name,
              oldTracks: oldCount,
              otherTracks: otherTracks.length,
            });
          }
        }
      }
    }

    const currentTracks: string[] = [];
    let skippedFromSingle = 0;
    let skippedFromDeluxe = 0;

    for (const track of albumTracks) {
      if (titleTrackOnly && track.id !== titleTrackOnly) {
        skippedCount++;
        continue;
      }
      if (exclude.has(track.id)) {
        skippedCount++;
        continue;
      }
      if (originalTrackKeys?.has(track.key)) {
        skippedFromDeluxe++;
        skippedCount++;
        continue;
      }
      if (release.type === 'single' && seenKeys.has(track.key)) {
        skippedFromSingle++;
        skippedCount++;
        continue;
      }
      if (seenIds.has(track.id)) continue;

      currentTracks.push(track.id);
      seenIds.add(track.id);
      seenKeys.add(track.key);
    }

    if (currentTracks.length > 0) {
      collected.push({ release, trackIds: currentTracks });
    } else if (release.type === 'single' && skippedFromSingle > 0) {
      run.decisions.push({ kind: 'single-skipped', release: release.name });
    }

    if (skippedFromDeluxe > 0 && isDeluxeRelease(release.name)) {
      run.decisions.push({
        kind: 'deluxe-stripped',
        release: release.name,
        baseName: getBaseAlbumName(release.name),
        originalTrackCount: skippedFromDeluxe,
        bonusTracks: currentTracks.length,
      });
    }
  }

  return { collected, skippedCount };
}

/** Track keys of the non-deluxe base album matching `baseAlbumName`. */
async function getOriginalAlbumTrackKeys(
  run: Run,
  artistId: string,
  baseAlbumName: string,
): Promise<Set<string>> {
  const trackKeys = new Set<string>();
  const albums = await memoArtistAlbums(run, artistId);
  for (const album of albums) {
    const albumBase = getBaseAlbumName(album.name);
    if (
      albumBase.toLowerCase() === baseAlbumName.toLowerCase() &&
      !isDeluxeRelease(album.name)
    ) {
      const tracks = await run.reads.albumTracks(album.id);
      for (const track of tracks) trackKeys.add(track.key);
      return trackKeys;
    }
  }
  return trackKeys;
}

/** Track keys from up to 3 of the artist's albums released before a date. */
async function getArtistPreviousTrackKeys(
  run: Run,
  artistId: string,
  beforeDate: string,
  cache: Map<string, Set<string>>,
): Promise<Set<string>> {
  const cached = cache.get(artistId);
  if (cached) return cached;

  const trackKeys = new Set<string>();
  const albums = await memoArtistAlbums(run, artistId);
  let albumsFetched = 0;
  for (const album of albums) {
    if (album.type !== 'album') continue;
    if (album.release_date >= beforeDate) continue;
    const tracks = await run.reads.albumTracks(album.id);
    for (const track of tracks) trackKeys.add(track.key);
    albumsFetched++;
    if (albumsFetched >= 3) break;
  }
  cache.set(artistId, trackKeys);
  return trackKeys;
}
