import {
  type GenreFilterLists,
  isGenreAcceptable,
} from '../../domain/filters.js';
import {
  filterLowPopularity,
  filterVariants,
  releaseDateFallbackMatch,
} from '../../domain/releases.js';
import { getValidDates, parseDate } from '../../domain/tracks.js';
import type {
  AlbumTrack,
  FoundRelease,
  PlaylistAlbumInfo,
  TrustedArtistsFile,
} from '../../lib/types.js';
import { type Run, collectTracks, getArtistWindowReleases } from './engine.js';

// ── Ports (the seam) ─────────────────────────────────────────────────────────

export interface RawAlbum {
  id: string;
  name: string;
  type: string;
  release_date: string;
  markets: number;
}

export interface AlbumDetails {
  id: string;
  name: string;
  type: string;
  release_date: string;
  /** True when any track on the album is explicit. */
  explicit: boolean;
  markets: number;
  artists: Array<{ id: string; name: string }>;
}

export interface ArtistProfile {
  popularity: number;
  followers: number;
  genres: string[];
}

/**
 * The Spotify reads a week collection needs. Prod adapter wraps
 * SpotifyContext + pagination; test adapter is an in-memory fixture catalog.
 *
 * Error contract: every method throws on auth failure (the caller re-auths
 * and retries the week). `searchArtist`, `albumDetails` and `artistProfile`
 * return null on other failures so collection degrades instead of aborting;
 * `userPlaylists` returns []. The paginated reads may throw on persistent
 * failures.
 */
export interface ReleaseReads {
  searchArtist(name: string): Promise<{ id: string; name: string } | null>;
  /** Artist album/single/compilation pages, flattened (first 3 pages). */
  artistAlbums(artistId: string): Promise<RawAlbum[]>;
  albumDetails(albumId: string): Promise<AlbumDetails | null>;
  albumTracks(albumId: string): Promise<AlbumTrack[]>;
  playlistAlbums(playlistId: string): Promise<Map<string, PlaylistAlbumInfo>>;
  userPlaylists(userId: string): Promise<Array<{ id: string; name: string }>>;
  artistProfile(artistId: string): Promise<ArtistProfile | null>;
}

/** Release popularity lookup. Prod = Deezer; test = fixed map. */
export interface PopularitySource {
  /** Release id → 0–100 popularity. Omitted ids are treated as unknown. */
  lookup(
    releases: Map<string, FoundRelease>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<string, number>>;
}

/**
 * Week-progress persistence. The module owns checkpoint cadence (every
 * `CHECKPOINT_EVERY` searched artists, and on any throw mid-search) and
 * resume; the store only decides where progress lives.
 */
export interface CheckpointStore {
  load(week: string): Promise<WeekProgress | null>;
  save(progress: WeekProgress): Promise<void>;
  clear(week: string): Promise<void>;
}

export interface WeekProgress {
  week: string;
  artistsSearched: number;
  foundReleases: Record<string, FoundRelease>;
}

export interface WeekCollectionPorts {
  reads: ReleaseReads;
  popularity: PopularitySource;
  checkpoints: CheckpointStore;
}

// ── Collection decisions (the audit trail, returned as data) ────────────────

export type VariantStripReason =
  | 'instrumental'
  | 'clean'
  | 'acoustic'
  | 'sped up'
  | 'slowed'
  | 'all-instrumental';

export type CollectionDecision =
  | {
      kind: 'release-found';
      artist: string;
      release: string;
      type: string;
      source?: string;
    }
  | {
      kind: 'variant-picked';
      release: string;
      variantCount: number;
      explicit: boolean;
    }
  | {
      kind: 'variant-stripped';
      reason: VariantStripReason;
      artist: string;
      release: string;
    }
  | {
      kind: 'low-popularity';
      artist: string;
      release: string;
      popularity: number;
    }
  | {
      kind: 'deluxe-stripped';
      release: string;
      baseName: string;
      originalTrackCount: number;
      bonusTracks: number;
    }
  | {
      kind: 'title-track-only';
      release: string;
      track: string;
      oldTracks: number;
      otherTracks: number;
    }
  | { kind: 'single-skipped'; release: string };

// ── Progress (liveness only — never carries decisions) ──────────────────────

export type WeekProgressEvent =
  | { phase: 'resumed'; searched: number; total: number; found: number }
  | { phase: 'searching'; searched: number; total: number; artist: string }
  | {
      phase: 'release-found';
      artist: string;
      release: string;
      type: string;
      source?: string;
    }
  | { phase: 'checkpoint'; searched: number; total: number }
  | { phase: 'editorial'; playlist: string }
  | { phase: 'popularity'; done: number; total: number }
  | { phase: 'collecting'; done: number; total: number; release: string };

// ── Input / result ───────────────────────────────────────────────────────────

export interface EditorialConfig {
  playlists: Array<{ id: string; name: string }>;
  externalSources: Array<{
    userId: string;
    namePattern: string;
    dateFormat: string;
    label: string;
  }>;
  gate: { minPopularity: number; minFollowers: number };
  genreFilters?: GenreFilterLists;
}

export interface WeekCollectionInput {
  /** The Friday, `DD.MM.YY`. Drives the date window and the checkpoint key. */
  week: string;
  /** P1/P2 roster to search: [artistName, { priority, score, spotifyId }]. */
  roster: Array<
    [
      string,
      { priority: number | null; score: number; spotifyId?: string | null },
    ]
  >;
  /** Full roster, to resolve editorial finds to P1/P2 or 'editorial'. */
  trustedArtists: TrustedArtistsFile;
  /** Track ids already in the listening history — excluded outright. */
  listeningHistory: Set<string>;
  editorial: EditorialConfig;
}

export interface WeekCollection {
  week: string;
  /** Final play order: popularity-ranked releases, albums before singles. */
  tracks: string[];
  /** Surviving releases in collection order, with contributed track counts. */
  releases: Array<FoundRelease & { tracksAdded: number }>;
  /** Complete chronological audit trail. Tests assert on this. */
  decisions: CollectionDecision[];
  /** Tracks considered but excluded by any dedup/gate rule. */
  skippedCount: number;
}

const CHECKPOINT_EVERY = 50;

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Gather one Friday's week collection.
 *
 * Invariants on a normal return: no track id appears twice and none from the
 * listening history appears at all; every track traces to exactly one release;
 * each release kept exactly one variant; `decisions` records every choice
 * that altered the outcome, in the order it was made.
 *
 * Error mode: any throw during the artist search phase checkpoints week
 * progress first, then propagates — a later call with the same week resumes
 * from the checkpoint. Auth errors always propagate. A per-artist search
 * failure skips that artist. On completing the search phase the checkpoint
 * is cleared.
 */
export async function collectWeek(
  input: WeekCollectionInput,
  ports: WeekCollectionPorts,
  onProgress?: (e: WeekProgressEvent) => void,
): Promise<WeekCollection> {
  const { week, roster, trustedArtists, listeningHistory, editorial } = input;
  const { reads, popularity, checkpoints } = ports;
  const validDates = getValidDates(parseDate(week));
  const run: Run = {
    reads,
    decisions: [],
    onProgress,
    albumsByArtist: new Map(),
  };

  // ── Search P1/P2 artists (resuming from checkpoint) ───────────────────────
  const foundReleases = new Map<string, FoundRelease>();
  let artistsSearched = 0;
  const saved = await checkpoints.load(week);
  if (saved && saved.artistsSearched > 0) {
    artistsSearched = saved.artistsSearched;
    for (const [id, release] of Object.entries(saved.foundReleases)) {
      foundReleases.set(id, release);
    }
    onProgress?.({
      phase: 'resumed',
      searched: artistsSearched,
      total: roster.length,
      found: foundReleases.size,
    });
  }

  try {
    for (let ai = artistsSearched; ai < roster.length; ai++) {
      const [name, data] = roster[ai];
      // Anchor to the artist that actually earned the priority. A fresh name
      // search can resolve a common name (e.g. "Ebenezer") to an unrelated
      // Spotify artist and pull in their whole catalog. Fall back to search
      // only when no id was stored.
      const artist = data.spotifyId
        ? { id: data.spotifyId, name }
        : await reads.searchArtist(name);
      if (!artist) {
        artistsSearched = ai + 1;
        continue;
      }
      const releases = await getArtistWindowReleases(
        run,
        artist.id,
        validDates,
      );
      for (const release of releases) {
        if (!foundReleases.has(release.id)) {
          foundReleases.set(release.id, {
            id: release.id,
            name: release.name,
            type: release.type,
            release_date: release.release_date,
            markets: release.markets,
            artistName: name,
            artistSpotifyId: artist.id,
            priority: data.priority ?? 0,
            score: data.score,
          });
          run.decisions.push({
            kind: 'release-found',
            artist: name,
            release: release.name,
            type: release.type,
          });
          onProgress?.({
            phase: 'release-found',
            artist: name,
            release: release.name,
            type: release.type,
          });
        }
      }
      artistsSearched = ai + 1;
      onProgress?.({
        phase: 'searching',
        searched: artistsSearched,
        total: roster.length,
        artist: name,
      });
      if (artistsSearched % CHECKPOINT_EVERY === 0) {
        await checkpoints.save({
          week,
          artistsSearched,
          foundReleases: Object.fromEntries(foundReleases),
        });
        onProgress?.({
          phase: 'checkpoint',
          searched: artistsSearched,
          total: roster.length,
        });
      }
    }
  } catch (e) {
    await checkpoints.save({
      week,
      artistsSearched,
      foundReleases: Object.fromEntries(foundReleases),
    });
    throw e;
  }

  await checkpoints.clear(week);

  // ── Editorial merge ────────────────────────────────────────────────────────
  await mergeEditorial(
    run,
    week,
    validDates,
    foundReleases,
    trustedArtists,
    editorial,
  );

  // ── Popularity gate + ranking ─────────────────────────────────────────────
  const releasePopularity = await popularity.lookup(
    foundReleases,
    (done, total) => onProgress?.({ phase: 'popularity', done, total }),
  );
  const lowPop = filterLowPopularity(
    foundReleases,
    releasePopularity,
    editorial.gate.minPopularity,
  );
  for (const id of lowPop) {
    const r = foundReleases.get(id);
    if (!r) continue;
    run.decisions.push({
      kind: 'low-popularity',
      artist: r.artistName,
      release: r.name,
      popularity: releasePopularity.get(id) ?? 0,
    });
    foundReleases.delete(id);
  }

  // ── Variant strip (alternate versions of kept releases) ──────────────────
  const { filtered: variantIds, removed } = filterVariants(foundReleases);
  for (const { type, release } of removed) {
    run.decisions.push({
      kind: 'variant-stripped',
      reason: type as VariantStripReason,
      artist: release.artistName,
      release: release.name,
    });
  }
  for (const id of variantIds) foundReleases.delete(id);

  // ── Track collection (deluxe / title-track / history dedup) ──────────────
  const { collected, skippedCount } = await collectTracks(
    run,
    foundReleases,
    listeningHistory,
  );

  const releases = collected.map((c) => ({
    ...c.release,
    tracksAdded: c.trackIds.length,
  }));
  const ranked = [...collected].sort(
    (a, b) =>
      (releasePopularity.get(b.release.id) ?? 0) -
      (releasePopularity.get(a.release.id) ?? 0),
  );
  const tracks = ranked.flatMap((c) => c.trackIds);

  return { week, tracks, releases, decisions: run.decisions, skippedCount };
}

// ── Editorial merge ──────────────────────────────────────────────────────────

function formatExternalDate(week: string, dateFormat: string): string {
  const dd = week.slice(0, 2);
  const mm = week.slice(3, 5);
  const yy = week.slice(6, 8);
  if (dateFormat === 'DD.MM.YYYY') return `${dd}.${mm}.20${yy}`;
  if (dateFormat === 'YYYY-MM-DD') return `20${yy}-${mm}-${dd}`;
  if (dateFormat === 'MM/DD/YYYY') return `${mm}/${dd}/20${yy}`;
  return `${dd}.${mm}.20${yy}`;
}

async function mergeEditorial(
  run: Run,
  week: string,
  validDates: string[],
  foundReleases: Map<string, FoundRelease>,
  trustedArtists: TrustedArtistsFile,
  editorial: EditorialConfig,
): Promise<void> {
  const playlists = [...editorial.playlists];

  for (const source of editorial.externalSources) {
    const dateStr = formatExternalDate(week, source.dateFormat);
    const pattern = new RegExp(source.namePattern);
    const candidates = await run.reads.userPlaylists(source.userId);
    const match = candidates.find(
      (p) => p.name.includes(dateStr) && pattern.test(p.name),
    );
    if (match) playlists.unshift({ id: match.id, name: match.name });
  }

  const releaseKeys = new Set(
    [...foundReleases.values()].map(
      (r) => `${r.artistName.toLowerCase()}|${r.name.toLowerCase().trim()}`,
    ),
  );

  for (const playlist of playlists) {
    run.onProgress?.({ phase: 'editorial', playlist: playlist.name });
    const albums = await run.reads.playlistAlbums(playlist.id);
    for (const [albumId, albumInfo] of albums) {
      if (foundReleases.has(albumId)) continue;
      const infoKey = `${albumInfo.artistName.toLowerCase()}|${albumInfo.name.toLowerCase().trim()}`;
      if (releaseKeys.has(infoKey)) continue;

      const album = await run.reads.albumDetails(albumId);
      if (!album) continue;
      const releaseDate = album.release_date;
      if (releaseDate.length === 10) {
        if (!validDates.includes(releaseDate)) continue;
      } else if (!releaseDateFallbackMatch(releaseDate, validDates)) {
        continue;
      }

      const primaryArtist = album.artists[0];
      const artistName = primaryArtist.name;
      const artistData = trustedArtists.artistCounts[artistName];

      const admit = (priority: number | 'editorial', score: number) => {
        foundReleases.set(albumId, {
          id: albumId,
          name: album.name,
          type: album.type,
          release_date: album.release_date,
          artistName,
          artistSpotifyId: primaryArtist.id,
          priority,
          score,
        });
        releaseKeys.add(
          `${artistName.toLowerCase()}|${album.name.toLowerCase().trim()}`,
        );
        run.decisions.push({
          kind: 'release-found',
          artist: artistName,
          release: album.name,
          type: album.type,
          source: playlist.name,
        });
        run.onProgress?.({
          phase: 'release-found',
          artist: artistName,
          release: album.name,
          type: album.type,
          source: playlist.name,
        });
      };

      if (
        artistData &&
        (artistData.priority === 1 || artistData.priority === 2)
      ) {
        admit(artistData.priority, artistData.score);
      } else {
        const profile = await run.reads.artistProfile(primaryArtist.id);
        if (!profile) continue;
        if (
          (profile.popularity >= editorial.gate.minPopularity ||
            profile.followers >= editorial.gate.minFollowers) &&
          isGenreAcceptable(profile.genres, editorial.genreFilters)
        ) {
          admit('editorial', 0);
        }
      }
    }
  }
}
