import {
  filterLowPopularity,
  filterVariants,
  getBaseAlbumName,
  groupReleases,
  isAllInstrumental,
  isDeluxeRelease,
  type RawRelease,
  releaseDateCouldMatch,
  releaseDateFallbackMatch,
} from '../../domain/releases.js';
import type { AlbumTrack, FoundRelease } from '../../lib/types.js';
import type {
  CollectionDecision,
  PopularitySource,
  RawAlbum,
  ReleaseReads,
  VariantStripReason,
  WeekProgressEvent,
} from './index.js';

/**
 * Release discovery and release qualification, built on `ReleaseReads` and
 * `PopularitySource`.
 *
 * Week collection and promotion sync both drive it: discover releases, `gate`
 * them on popularity, then `collect` the qualifying tracks. Between the two,
 * week collection runs its AI phase. Decisions accumulate on the run in the
 * order they're made, across every step and caller phase.
 */
export interface Run {
  reads: ReleaseReads;
  popularity: PopularitySource;
  decisions: CollectionDecision[];
  onProgress?: (e: WeekProgressEvent) => void;
  /** artistAlbums responses memoized for the lifetime of one run. */
  albumsByArtist: Map<string, RawAlbum[]>;
  /** Name-search fallbacks memoized for the lifetime of one run. */
  artistIdsByName: Map<string, string | null>;
  /** Reads time for step timings; injected so tests can pin it. */
  now: () => number;
}

export function createRun(
  ports: {
    reads: ReleaseReads;
    popularity: PopularitySource;
    now?: () => number;
  },
  onProgress?: (e: WeekProgressEvent) => void,
): Run {
  return {
    reads: ports.reads,
    popularity: ports.popularity,
    decisions: [],
    onProgress,
    albumsByArtist: new Map(),
    artistIdsByName: new Map(),
    now: ports.now ?? Date.now,
  };
}

export interface Collected {
  release: FoundRelease;
  trackIds: string[];
}

// ── Popularity gate ──────────────────────────────────────────────────────────

/**
 * Drop releases below `minPopularity`, each with a `low-popularity` decision.
 * A release with no known popularity passes. Returns the popularity map too:
 * week collection ranks by it and feeds it to the AI phase.
 */
export async function gate(
  run: Run,
  releases: Map<string, FoundRelease>,
  minPopularity: number,
): Promise<{
  kept: Map<string, FoundRelease>;
  dropped: FoundRelease[];
  popularity: Map<string, number>;
}> {
  const popularity = await run.popularity.lookup(releases, (done, total) =>
    run.onProgress?.({ phase: 'popularity', done, total }),
  );
  const low = filterLowPopularity(releases, popularity, minPopularity);
  const kept = new Map<string, FoundRelease>();
  const dropped: FoundRelease[] = [];
  for (const [id, release] of releases) {
    if (!low.has(id)) {
      kept.set(id, release);
      continue;
    }
    run.decisions.push({
      kind: 'low-popularity',
      artist: release.artistName,
      release: release.name,
      albumId: id,
      popularity: popularity.get(id) ?? 0,
    });
    dropped.push(release);
  }
  return { kept, dropped, popularity };
}

// ── Collection ───────────────────────────────────────────────────────────────

/**
 * Tracks removed outright: by id, and optionally by normalized key, which also
 * catches the same song under another release's track id (a single of an album
 * track already present).
 */
export interface Exclusion {
  ids: Set<string>;
  keys?: Set<string>;
}

/**
 * The qualifying tracks of `releases`: strip alternate versions of kept
 * releases, then apply the track rules (see `collectTracks`). A release whose
 * reads throw fails the collection, unless `contain` returns true for it: then
 * it's dropped, returned in `contained`, and collection goes on.
 */
export async function collect(
  run: Run,
  releases: Map<string, FoundRelease>,
  exclude: Exclusion,
  contain?: (release: FoundRelease, error: unknown) => boolean,
): Promise<{
  collected: Collected[];
  skippedCount: number;
  contained: Array<{ release: FoundRelease; error: unknown }>;
}> {
  const { filtered, removed } = filterVariants(releases);
  for (const { type, release } of removed) {
    run.decisions.push({
      kind: 'variant-stripped',
      reason: type as VariantStripReason,
      artist: release.artistName,
      release: release.name,
    });
  }
  const remaining = new Map([...releases].filter(([id]) => !filtered.has(id)));
  const result = await collectTracks(run, remaining, exclude, contain);
  // A release is found only once it lands; one filtered out, or whose tracks
  // were all excluded, records only the decision that dropped it.
  for (const { release } of result.collected) {
    run.decisions.push({
      kind: 'release-found',
      artist: release.artistName,
      release: release.name,
      type: release.type,
      ...(release.source ? { source: release.source } : {}),
    });
  }
  return result;
}

export type WindowRelease = RawRelease & { markets: number };

// ── Artist release discovery ─────────────────────────────────────────────────

/** A roster artist: name, tier and score, and the Spotify id if stored. */
export interface RosterArtist {
  name: string;
  priority: number | null;
  score: number;
  spotifyId?: string | null;
}

/**
 * A roster artist's in-window releases, one variant each, as found releases.
 * Anchored to the stored Spotify id: a fresh name search can resolve a common
 * name (e.g. "Ebenezer") to an unrelated artist and pull in their whole
 * catalog, so the search is only a fallback when no id was stored. Null when
 * the artist isn't on Spotify.
 */
export async function discoverArtist(
  run: Run,
  artist: RosterArtist,
  validDates: string[],
): Promise<FoundRelease[] | null> {
  const artistId = artist.spotifyId ?? (await searchArtistId(run, artist.name));
  if (!artistId) return null;
  const releases = await getArtistWindowReleases(run, artistId, validDates);
  return releases.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    release_date: r.release_date,
    markets: r.markets,
    artistName: artist.name,
    artistSpotifyId: artistId,
    priority: artist.priority ?? 0,
    score: artist.score,
  }));
}

async function searchArtistId(run: Run, name: string) {
  if (run.artistIdsByName.has(name)) return run.artistIdsByName.get(name);
  const id = (await run.reads.searchArtist(name))?.id ?? null;
  run.artistIdsByName.set(name, id);
  return id;
}

async function memoArtistAlbums(run: Run, artistId: string) {
  const cached = run.albumsByArtist.get(artistId);
  if (cached) return cached;
  const albums = await run.reads.artistAlbums(artistId);
  run.albumsByArtist.set(artistId, albums);
  return albums;
}

/** Window-filter an artist's releases, then keep one variant per group. */
async function getArtistWindowReleases(
  run: Run,
  artistId: string,
  validDates: string[],
): Promise<WindowRelease[]> {
  const inWindow = await getArtistInWindow(run, artistId, validDates);
  const releases: WindowRelease[] = [];
  for (const [, group] of groupReleases(inWindow)) {
    releases.push(await chooseVariant(run, group as WindowRelease[]));
  }
  return releases;
}

/** An artist's releases inside the window, every variant included. */
export async function getArtistInWindow(
  run: Run,
  artistId: string,
  validDates: string[],
): Promise<WindowRelease[]> {
  const albums = await memoArtistAlbums(run, artistId);
  const inWindow: WindowRelease[] = [];

  for (const album of albums) {
    // Spotify reports some release dates at month/year precision. When such a
    // date could fall in the window, fetch the album for a day-precise date;
    // failing that, apply the end-of-period fallback match.
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
  return inWindow;
}

/**
 * Same-release duplicates: keep the explicit variant, then the one with the
 * widest market coverage. A choice among several is a `variant-picked`.
 */
export async function chooseVariant(
  run: Run,
  group: WindowRelease[],
): Promise<WindowRelease> {
  if (group.length === 1) return group[0];
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
    } else if (info.explicit === bestIsExplicit && info.markets > bestMarkets) {
      best = release;
      bestMarkets = info.markets;
    }
  }
  run.decisions.push({
    kind: 'variant-picked',
    release: best.name,
    variantCount: group.length,
    explicit: bestIsExplicit,
  });
  return best;
}

// ── Track collection ─────────────────────────────────────────────────────────

/**
 * Collect playable track ids for the given releases, applying deluxe,
 * title-track-only, and album/single dedup rules. `exclude` holds the tracks
 * removed outright (the listening history for a week collection; the All Weekly
 * ids plus the playlist's existing tracks, by id and key, for a promotion sync).
 */
async function collectTracks(
  run: Run,
  foundReleases: Map<string, FoundRelease>,
  exclude: Exclusion,
  contain?: (release: FoundRelease, error: unknown) => boolean,
): Promise<{
  collected: Collected[];
  skippedCount: number;
  contained: Array<{ release: FoundRelease; error: unknown }>;
}> {
  const collected: Collected[] = [];
  const contained: Array<{ release: FoundRelease; error: unknown }> = [];
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
    let fetched: ReleaseReadings;
    try {
      fetched = await readRelease(run, albumId, release, previousKeysByArtist);
    } catch (error) {
      if (!contain?.(release, error)) throw error;
      contained.push({ release, error });
      continue;
    }
    const { albumTracks, originalTrackKeys, titleTrack, previousKeys } =
      fetched;

    if (albumTracks.length > 0 && isAllInstrumental(albumTracks)) {
      run.decisions.push({
        kind: 'variant-stripped',
        reason: 'all-instrumental',
        artist: release.artistName,
        release: release.name,
      });
      continue;
    }

    // Title-track-only: single promotion disguised as an album.
    let titleTrackOnly: string | null = null;
    if (titleTrack && previousKeys && previousKeys.size > 0) {
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

    const currentTracks: string[] = [];
    let skippedFromSingle = 0;
    let skippedFromDeluxe = 0;

    for (const track of albumTracks) {
      if (titleTrackOnly && track.id !== titleTrackOnly) {
        skippedCount++;
        continue;
      }
      if (exclude.ids.has(track.id) || exclude.keys?.has(track.key)) {
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

  return { collected, skippedCount, contained };
}

interface ReleaseReadings {
  albumTracks: AlbumTrack[];
  /** Deluxe release: the base album's track keys; null otherwise. */
  originalTrackKeys: Set<string> | null;
  /** A track named after the release, on a multi-track release. */
  titleTrack: AlbumTrack | null;
  /** The artist's earlier track keys; fetched only with a title track. */
  previousKeys: Set<string> | null;
}

/** Every Spotify read one release's track rules need, done up front. */
async function readRelease(
  run: Run,
  albumId: string,
  release: FoundRelease,
  previousKeysByArtist: Map<string, Set<string>>,
): Promise<ReleaseReadings> {
  const albumTracks = await run.reads.albumTracks(albumId);
  if (albumTracks.length > 0 && isAllInstrumental(albumTracks)) {
    return {
      albumTracks,
      originalTrackKeys: null,
      titleTrack: null,
      previousKeys: null,
    };
  }
  // Deluxe release: only tracks absent from the base album qualify.
  const originalTrackKeys = isDeluxeRelease(release.name)
    ? await getOriginalAlbumTrackKeys(
        run,
        release.artistSpotifyId,
        getBaseAlbumName(release.name),
      )
    : null;
  const titleTrack =
    albumTracks.length > 1
      ? (albumTracks.find(
          (t) => t.name.toLowerCase() === release.name.toLowerCase(),
        ) ?? null)
      : null;
  const previousKeys = titleTrack
    ? await getArtistPreviousTrackKeys(
        run,
        release.artistSpotifyId,
        release.release_date,
        previousKeysByArtist,
      )
    : null;
  return { albumTracks, originalTrackKeys, titleTrack, previousKeys };
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

/**
 * Track keys from up to 3 of the artist's albums released before a date.
 * Cached per artist, ignoring `beforeDate`: every release in one
 * `collectTracks` call shares a single week's window, so the first date asked
 * stands for the rest.
 */
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
