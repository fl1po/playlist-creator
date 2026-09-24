/**
 * Release discovery and qualification for one year.
 *
 * Q10 settled the shape: bodies of work only — albums and EPs, no standalone
 * singles — and no reissues, compilations, live albums or remix packs. Two
 * details make this harder than it sounds:
 *
 * - Spotify's `album_type: 'single'` is badly overloaded. It covers true
 *   one-track singles, EPs of 6–14 tracks, remix packs, and the occasional
 *   mislabeled 25-track compilation. Type alone cannot decide.
 *
 * - Reissues carry the *reissue* date, so a 2016-stamped remaster of a 1994
 *   record looks like a 2016 release and scores high on acclaim. Name
 *   patterns catch the labelled ones; `priorBaseNames` catches the rest by
 *   noticing the artist already released something under that base name.
 */

import { getBaseAlbumName, isDeluxeRelease } from '../../domain/releases.js';
import type { SpotifyContext } from '../../lib/spotify-context.js';
import type { PhaseReporter } from './checkpoint.js';

/** Minimum tracks for a `single`-typed release to count as an EP. */
export const EP_MIN_TRACKS = 4;

/** Above this, a `single`-typed release is almost certainly mislabeled. */
export const SINGLE_MAX_TRACKS = 20;

const PAGE = 50;
/** Deep enough for prolific catalogs without unbounded paging. */
const MAX_ALBUMS = 500;

const REISSUE =
  /\b(remaster|remastered|reissue|re-?issue|anniversary|redux)\b/i;
const COMPILATION =
  /\b(greatest hits|best of|the collection|anthology|essentials|retrospective|singles collection)\b/i;
const LIVE =
  /\b(live at|live from|live in|live session|unplugged|in concert)\b|[\(\[]\s*live\s*[\)\]]/i;
const REMIX_PACK = /\bremix(es|ed)?\b/i;

export interface RawAlbum {
  id: string;
  name: string;
  albumType: string;
  releaseDate: string;
  totalTracks: number;
  markets: number;
}

export interface YearRelease extends RawAlbum {
  artistId: string;
  artistName: string;
}

export interface Rejection {
  artistName: string;
  name: string;
  albumType: string;
  totalTracks: number;
  reason: string;
}

/**
 * Every album Spotify lists for an artist.
 *
 * Fetched whole rather than filtered server-side: the endpoint has no date
 * filter, and the full list is what lets `exclusionReason` spot reissues by
 * finding an earlier release under the same base name.
 *
 * `complete` is false when a page failed and the list is truncated.
 */
export async function fetchArtistAlbums(
  ctx: SpotifyContext,
  artistId: string,
  report?: PhaseReporter,
): Promise<{ albums: RawAlbum[]; complete: boolean }> {
  const albums: RawAlbum[] = [];
  let offset = 0;

  while (offset < MAX_ALBUMS) {
    report?.attempt();
    const result = await ctx.call(
      () =>
        ctx.api.artists.albums(
          artistId,
          'album,single,compilation',
          undefined,
          PAGE,
          offset,
        ),
      `albums for ${artistId}`,
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      // Breaking here truncates the artist's catalog, so the year may look
      // empty when it is not. That is invisible downstream — hence the count.
      report?.fail();
      return { albums, complete: false };
    }

    for (const album of result.data.items) {
      albums.push({
        id: album.id,
        name: album.name,
        albumType: album.album_type,
        releaseDate: album.release_date,
        totalTracks: album.total_tracks ?? 0,
        markets: album.available_markets?.length ?? 0,
      });
    }

    if (result.data.items.length < PAGE) break;
    offset += PAGE;
  }

  return { albums, complete: true };
}

export interface AlbumDetail {
  popularity: number;
  /** Track ids in album sequence — disc, then track number. */
  trackIds: string[];
  trackNames: string[];
}

/**
 * Album popularity *and* track listing in one pass.
 *
 * These are fetched together deliberately: `albums.get` returns both, the
 * plan needs the track ids so `--apply` never re-fetches, and splitting them
 * would double the most expensive call in the pipeline.
 */
export async function fetchAlbumDetails(
  ctx: SpotifyContext,
  albumIds: string[],
  onProgress?: (done: number, total: number) => void,
  report?: PhaseReporter,
): Promise<Map<string, AlbumDetail>> {
  const out = new Map<string, AlbumDetail>();
  const unique = [...new Set(albumIds)];
  const BATCH = 20;

  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    report?.attempt(batch.length);
    const result = await ctx.call(
      () => ctx.api.albums.get(batch),
      `album details batch ${i / BATCH + 1}`,
    );

    if (!result.success) {
      if (result.authError) throw result.error;
      // These releases would reach the plan with no track ids and contribute
      // nothing to the playlist while still appearing in the summary.
      report?.fail(batch.length);
    } else {
      for (const album of result.data) {
        if (!album) continue;
        const tracks = [...(album.tracks?.items ?? [])].sort(
          (a, b) =>
            (a.disc_number ?? 1) - (b.disc_number ?? 1) ||
            (a.track_number ?? 0) - (b.track_number ?? 0),
        );
        out.set(album.id, {
          popularity: album.popularity ?? 0,
          trackIds: tracks.map((t) => t.id).filter(Boolean),
          trackNames: tracks.map((t) => t.name),
        });
      }
    }
    onProgress?.(Math.min(i + BATCH, unique.length), unique.length);
  }

  return out;
}

/** Whether a release date falls in the target year. Precision-agnostic. */
export function inYear(releaseDate: string, year: number): boolean {
  return releaseDate.startsWith(String(year));
}

/**
 * Why a release does not qualify, or null if it does.
 *
 * `priorBaseNames` holds the base names of everything the artist released
 * *before* the target year — the structural reissue check.
 */
export function exclusionReason(
  album: RawAlbum,
  priorBaseNames: Set<string>,
): string | null {
  const name = album.name;

  if (album.albumType === 'compilation') return 'compilation';
  if (COMPILATION.test(name)) return 'compilation';
  if (LIVE.test(name)) return 'live';
  if (REMIX_PACK.test(name)) return 'remix-pack';
  if (REISSUE.test(name)) return 'reissue';

  if (album.albumType === 'single') {
    if (album.totalTracks < EP_MIN_TRACKS) return 'standalone-single';
    if (album.totalTracks > SINGLE_MAX_TRACKS) return 'mislabeled-compilation';
  }

  // An earlier release under the same base name means this is a re-release,
  // even when nothing in the title says so.
  const base = getBaseAlbumName(name).toLowerCase().trim();
  if (base && priorBaseNames.has(base)) return 'reissue-untitled';

  return null;
}

/**
 * Pick the qualifying releases an artist made in the target year.
 *
 * Where a base and a deluxe edition both appear in-year, the deluxe wins —
 * the inverse of weekly fill, where the base album was already added the week
 * it came out. Nothing has been added here, so the superset edition is the
 * complete record.
 */
export function selectYearReleases(
  albums: RawAlbum[],
  year: number,
  artistId: string,
  artistName: string,
): { releases: YearRelease[]; rejected: Rejection[] } {
  const priorBaseNames = new Set<string>();
  for (const album of albums) {
    const albumYear = Number(album.releaseDate.slice(0, 4));
    if (Number.isFinite(albumYear) && albumYear < year) {
      const base = getBaseAlbumName(album.name).toLowerCase().trim();
      if (base) priorBaseNames.add(base);
    }
  }

  const rejected: Rejection[] = [];
  const eligible: RawAlbum[] = [];

  for (const album of albums) {
    if (!inYear(album.releaseDate, year)) continue;
    const reason = exclusionReason(album, priorBaseNames);
    if (reason) {
      rejected.push({
        artistName,
        name: album.name,
        albumType: album.albumType,
        totalTracks: album.totalTracks,
        reason,
      });
      continue;
    }
    eligible.push(album);
  }

  // Collapse editions of the same record; prefer deluxe, then track count,
  // then market coverage.
  const groups = new Map<string, RawAlbum[]>();
  for (const album of eligible) {
    const key = getBaseAlbumName(album.name).toLowerCase().trim() || album.name;
    const group = groups.get(key);
    if (group) group.push(album);
    else groups.set(key, [album]);
  }

  const releases: YearRelease[] = [];
  for (const [, group] of groups) {
    const best = group.reduce((a, b) => (preferEdition(b, a) ? b : a));
    if (group.length > 1) {
      for (const album of group) {
        if (album.id === best.id) continue;
        rejected.push({
          artistName,
          name: album.name,
          albumType: album.albumType,
          totalTracks: album.totalTracks,
          reason: `superseded-by "${best.name}"`,
        });
      }
    }
    releases.push({ ...best, artistId, artistName });
  }

  releases.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  return { releases, rejected };
}

/** True when `a` is the better edition to keep over `b`. */
function preferEdition(a: RawAlbum, b: RawAlbum): boolean {
  const aDeluxe = isDeluxeRelease(a.name);
  const bDeluxe = isDeluxeRelease(b.name);
  if (aDeluxe !== bDeluxe) return aDeluxe;
  if (a.totalTracks !== b.totalTracks) return a.totalTracks > b.totalTracks;
  return a.markets > b.markets;
}
