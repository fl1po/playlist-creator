import {
  DEEZER_ARTISTS,
  type DeezerArtistCache,
} from '../../lib/cache-files.js';
import {
  type DeezerAlbumDetail,
  type DeezerArtistAlbum,
  DeezerClient,
  foldName,
} from '../../lib/deezer-client.js';
import type { DurableCache } from '../../lib/durable-cache.js';
import { isAbort } from '../../lib/spotify/errors.js';
import type {
  Candidate,
  CandidateProvenance,
  CandidateReject,
  CandidateSource,
} from '../week-collection/index.js';

// The production CandidateSource (ADR-0005), on Deezer. Roster artists below
// P1/P2 are never searched on Spotify: Deezer decides whether they released
// anything this week. Deezer failures shrink the pool instead of throwing;
// only abort gets out.

/** The Deezer reads the source needs; `DeezerClient` in production. */
export type DeezerReads = Pick<
  DeezerClient,
  'searchArtist' | 'searchAlbum' | 'artistAlbums' | 'getAlbum' | 'topTracks'
>;

export interface DeezerCandidateSourceOptions {
  /** Defaults to a fresh `DeezerClient`. */
  deezer?: DeezerReads;
  /** Holds artist lookups and top tracks between fills. */
  cache: DurableCache;
  /** Cooperative cancellation: throws to abort. Called once per artist. */
  checkAbort?: () => void;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Who an artist is on Deezer barely changes; their fan count drifts. */
const ARTIST_TTL_MS = 90 * DAY_MS;
/** An artist's usual tracks move slowly; a month keeps the ratio honest. */
const TOP_TRACKS_TTL_MS = 30 * DAY_MS;
/** Saved every this many fetched artists, so a crash keeps most of a build. */
const SAVE_EVERY = 50;
/** Deezer's rank for a brand-new track it hasn't ranked yet. */
const PLACEHOLDER_RANK = 100_000;

/** A Deezer lookup that failed, as opposed to one that found nothing. */
class DeezerUnavailable extends Error {}

type DeezerArtistRef = { id: number; fans: number };

export function deezerCandidateSource(
  opts: DeezerCandidateSourceOptions,
): CandidateSource {
  const deezer = opts.deezer ?? new DeezerClient();
  const now = opts.now ?? Date.now;
  const checkAbort = opts.checkAbort ?? (() => {});
  // Held for the adapter's life, so later weeks of a fill reuse them.
  let store: DeezerArtistCache | null = null;
  const albumLists = new Map<number, DeezerArtistAlbum[]>();
  const albumDetails = new Map<number, DeezerAlbumDetail>();
  let unsaved = 0;

  const fresh = (fetchedAt: number, ttl: number) => now() - fetchedAt < ttl;

  async function save(): Promise<void> {
    if (!(store && unsaved)) return;
    unsaved = 0;
    try {
      await opts.cache.save(DEEZER_ARTISTS, store);
    } catch {
      /* the cache is a speed-up; losing it costs refetches, not the week */
    }
  }

  async function markUnsaved(): Promise<void> {
    if (++unsaved >= SAVE_EVERY) await save();
  }

  /** The Deezer artist by this name; null when Deezer has none. */
  async function resolveArtist(
    cache: DeezerArtistCache,
    name: string,
  ): Promise<DeezerArtistRef | null> {
    const key = foldName(name);
    const cached = cache.artists[key];
    if (cached && fresh(cached.fetchedAt, ARTIST_TTL_MS)) return cached.deezer;
    const found = await deezer.searchArtist(name);
    if (found === null) throw new DeezerUnavailable(`artist ${name}`);
    const ref =
      found === 'not-found' ? null : { id: found.id, fans: found.nb_fan };
    cache.artists[key] = { deezer: ref, fetchedAt: now() };
    await markUnsaved();
    return ref;
  }

  async function artistAlbums(id: number): Promise<DeezerArtistAlbum[]> {
    let albums = albumLists.get(id);
    if (!albums) {
      const fetched = await deezer.artistAlbums(id);
      if (!fetched) throw new DeezerUnavailable(`albums of ${id}`);
      albums = fetched;
      albumLists.set(id, albums);
    }
    return albums;
  }

  async function albumDetail(id: number): Promise<DeezerAlbumDetail> {
    let album = albumDetails.get(id);
    if (!album) {
      const fetched = await deezer.getAlbum(id);
      if (!fetched) throw new DeezerUnavailable(`album ${id}`);
      album = fetched;
      albumDetails.set(id, album);
    }
    return album;
  }

  /**
   * The release's best track rank ÷ the median rank of the artist's top 10
   * tracks on other releases (the artist's usual), as in the prototype the
   * cap's 0.6 line was drawn from. Null when either side is unknown; a
   * placeholder rank counts as unknown. A failed top-tracks lookup isn't
   * cached.
   */
  async function relativePopularity(
    cache: DeezerArtistCache,
    artistId: number,
    album: DeezerAlbumDetail,
  ): Promise<number | null> {
    const best = Math.max(0, ...album.tracks.data.map((t) => t.rank));
    if (best === 0 || best === PLACEHOLDER_RANK) return null;
    const key = String(artistId);
    let top = cache.topTracks[key];
    if (!(top && fresh(top.fetchedAt, TOP_TRACKS_TTL_MS))) {
      const tracks = await deezer.topTracks(artistId).catch(rethrowAbort);
      if (!tracks) return null;
      top = { tracks, fetchedAt: now() };
      cache.topTracks[key] = top;
      await markUnsaved();
    }
    const usual = median(
      top.tracks
        .filter((t) => t.album !== album.id && t.rank !== PLACEHOLDER_RANK)
        .map((t) => t.rank),
    );
    return usual ? best / usual : null;
  }

  async function candidate(
    cache: DeezerArtistCache,
    artist: { name: string; id: number; fans: number | null },
    album: DeezerAlbumDetail,
  ): Promise<Omit<Candidate, 'id' | 'provenance'>> {
    return {
      title: album.title,
      artist: artist.name,
      type: album.record_type,
      trackCount: album.nb_tracks ?? album.tracks.data.length,
      releaseDate: album.release_date,
      genres: album.genres?.data.map((g) => g.name) ?? [],
      artistFans: artist.fans,
      upc: album.upc ?? null,
      relativePopularity: await relativePopularity(cache, artist.id, album),
    };
  }

  /** One roster artist's in-window releases; all or none. */
  async function rosterReleases(
    cache: DeezerArtistCache,
    roster: { name: string; priority: number | null },
    window: string[],
  ): Promise<Candidate[]> {
    const artist = await resolveArtist(cache, roster.name);
    if (!artist) return [];
    const provenance: CandidateProvenance = {
      kind: 'roster',
      priority: roster.priority,
    };
    const found: Candidate[] = [];
    for (const listed of await artistAlbums(artist.id)) {
      if (!window.includes(listed.release_date)) continue;
      const album = await albumDetail(listed.id);
      found.push({
        id: `dz-${album.id}`,
        ...(await candidate(cache, { ...artist, name: roster.name }, album)),
        provenance: [provenance],
      });
    }
    return found;
  }

  /** The reject as a candidate, with Deezer's data when Deezer has it. */
  async function enrichReject(
    cache: DeezerArtistCache,
    reject: CandidateReject,
  ): Promise<Candidate> {
    const known = bareReject(reject);
    const artist = await resolveArtist(cache, reject.artist);
    const hits = await deezer.searchAlbum(`${reject.artist} ${reject.title}`);
    const hit = hits.find(
      (h) =>
        (artist
          ? h.artist.id === artist.id
          : sameName(h.artist.name, reject.artist)) &&
        sameTitle(h.title, reject.title),
    );
    const fans = artist?.fans ?? null;
    if (!hit) return { ...known, artistFans: fans };
    const album = await albumDetail(hit.id);
    const deezerData = await candidate(
      cache,
      { name: reject.artist, id: hit.artist.id, fans },
      album,
    );
    // Spotify's title, type and date stay: they're what a pick lands as.
    return {
      ...known,
      ...deezerData,
      title: reject.title,
      type: reject.type,
      releaseDate: reject.releaseDate,
    };
  }

  return {
    async candidates(request) {
      store ??= (await opts.cache.load(DEEZER_ARTISTS)) ?? {
        artists: {},
        topTracks: {},
      };
      const cache = store;
      const byId = new Map<string, Candidate>();
      try {
        for (const roster of request.rosterArtists) {
          checkAbort();
          const found = await rosterReleases(
            cache,
            roster,
            request.window,
          ).catch(unlessAbort(() => []));
          for (const c of found) {
            // One album can arrive through two artist profiles.
            const seen = byId.get(c.id);
            if (seen) seen.provenance.push(...c.provenance);
            else byId.set(c.id, c);
          }
        }
        const rejects: Candidate[] = [];
        for (const reject of request.rejects) {
          checkAbort();
          rejects.push(
            await enrichReject(cache, reject).catch(
              unlessAbort(() => bareReject(reject)),
            ),
          );
        }
        return [...byId.values(), ...rejects];
      } finally {
        await save();
      }
    },
  };
}

/** A `.catch` handler: abort escapes, any other failure falls back. */
function unlessAbort<T>(fallback: () => T): (e: unknown) => T {
  return (e) => {
    rethrowAbort(e);
    return fallback();
  };
}

/** A `.catch` handler: abort escapes, any other failure becomes null. */
function rethrowAbort(e: unknown): null {
  if (isAbort(e)) throw e;
  return null;
}

/** A reject as the week knows it, before any Deezer data. */
function bareReject(reject: CandidateReject): Candidate {
  return {
    id: `reject-${reject.albumId}`,
    title: reject.title,
    artist: reject.artist,
    type: reject.type,
    trackCount: 1,
    releaseDate: reject.releaseDate,
    genres: [],
    artistFans: null,
    upc: null,
    relativePopularity: null,
    provenance: [reject.provenance],
    spotifyAlbumId: reject.albumId,
  };
}

/** The upper median, as the prototype took it. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
}

const sameName = (a: string, b: string) => foldName(a) === foldName(b);

/** Equal once folded, brackets and punctuation gone, or one holds the other. */
function sameTitle(a: string, b: string): boolean {
  const norm = (t: string) =>
    foldName(t)
      .replace(/\s*[([].*?[)\]]\s*/g, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  const na = norm(a);
  const nb = norm(b);
  if (!(na && nb)) return na === nb;
  return na === nb || na.includes(nb) || nb.includes(na);
}
