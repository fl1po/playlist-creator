import {
  DEEZER_ARTISTS,
  type DeezerArtistCache,
  RELATED_ARTIST_GRAPH,
  type RelatedArtist,
  type RelatedArtistEntry,
} from '../../lib/cache-files.js';
import {
  type DeezerAlbumDetail,
  type DeezerArtistAlbum,
  DeezerClient,
  foldName,
} from '../../lib/deezer-client.js';
import type { CacheDescriptor, DurableCache } from '../../lib/durable-cache.js';
import { isAbort } from '../../lib/spotify/errors.js';
import type {
  Candidate,
  CandidateProgress,
  CandidateProvenance,
  CandidateReject,
  CandidateRequest,
  CandidateSource,
} from '../week-collection/index.js';

// The production CandidateSource (ADR-0005), on Deezer. Roster artists below
// P1/P2 are never searched on Spotify: Deezer decides whether they released
// anything this week. Related artists come from the P1/P2 seeds' related-artist
// graph, cached per seed and topped up on the first call of a fill. Rejects
// and scouting-playlist albums the week knows from Spotify are looked up by
// artist and title, and come back with their Spotify album id, matched or not.
// Deezer failures shrink the pool instead of throwing; only abort gets out.

/** The Deezer reads the source needs; `DeezerClient` in production. */
export type DeezerReads = Pick<
  DeezerClient,
  | 'searchArtist'
  | 'searchAlbum'
  | 'artistAlbums'
  | 'getAlbum'
  | 'topTracks'
  | 'relatedArtists'
>;

export interface DeezerCandidateSourceOptions {
  /** Defaults to a fresh `DeezerClient`. */
  deezer?: DeezerReads;
  /** Holds artist lookups, top tracks and the related-artist graph between fills. */
  cache: DurableCache;
  /** Cooperative cancellation: throws to abort. Called once per seed and artist. */
  checkAbort?: () => void;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Who an artist is on Deezer barely changes; their fan count drifts. */
const ARTIST_TTL_MS = 90 * DAY_MS;
/** A seed's related artists drift slowly; the whole graph renews about quarterly. */
const GRAPH_TTL_MS = 90 * DAY_MS;
/** A related artist joins the pool once this many current seeds name it. */
const MIN_CO_CITATIONS = 2;
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
  const artistStore = batchedStore(opts.cache, DEEZER_ARTISTS, () => ({
    artists: {},
    topTracks: {},
  }));
  const graphStore = batchedStore(opts.cache, RELATED_ARTIST_GRAPH, () => ({}));
  const albumLists = new Map<number, DeezerArtistAlbum[]>();
  const albumDetails = new Map<number, DeezerAlbumDetail>();
  // Seeds looked up by this adapter, failed ones too: a failure is retried
  // by the next fill, not by every later week of this one.
  const lookedUp = new Set<string>();

  const fresh = (fetchedAt: number, ttl: number) => now() - fetchedAt < ttl;

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
    await artistStore.changed();
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
      await artistStore.changed();
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

  /** One Deezer artist's in-window releases; all or none. */
  async function artistReleases(
    cache: DeezerArtistCache,
    artist: RelatedArtist,
    provenance: CandidateProvenance,
    window: string[],
  ): Promise<Candidate[]> {
    const found: Candidate[] = [];
    for (const listed of await artistAlbums(artist.id)) {
      if (!window.includes(listed.release_date)) continue;
      const album = await albumDetail(listed.id);
      found.push({
        id: `dz-${album.id}`,
        ...(await candidate(cache, artist, album)),
        provenance: [provenance],
      });
    }
    return found;
  }

  /** One roster artist's in-window releases; all or none. */
  async function rosterReleases(
    cache: DeezerArtistCache,
    roster: { name: string; priority: number | null },
    window: string[],
  ): Promise<Candidate[]> {
    const artist = await resolveArtist(cache, roster.name);
    if (!artist) return [];
    return artistReleases(
      cache,
      { ...artist, name: roster.name },
      { kind: 'roster', priority: roster.priority },
      window,
    );
  }

  /** The seed's graph entry, fetched now; throws when a lookup fails. */
  async function fetchEntry(
    cache: DeezerArtistCache,
    seed: Seed,
  ): Promise<RelatedArtistEntry> {
    const artist = await resolveArtist(cache, seed.name);
    if (!artist) return { deezerId: null, related: [], fetchedAt: now() };
    const related = await deezer.relatedArtists(artist.id);
    if (!related) throw new DeezerUnavailable(`related of ${seed.name}`);
    return {
      deezerId: artist.id,
      related: related.map((a) => ({ id: a.id, name: a.name, fans: a.nb_fan })),
      fetchedAt: now(),
    };
  }

  /**
   * Fetch the seeds with no entry or a stale one, unless this adapter
   * already tried. A failed fetch keeps whatever entry was there.
   */
  async function topUpGraph(
    cache: DeezerArtistCache,
    graph: RelatedGraph,
    seeds: Seed[],
    onProgress: (e: CandidateProgress) => void,
  ): Promise<void> {
    const due = seeds
      .map((seed) => ({ seed, key: seedKey(seed) }))
      .filter(({ key }) => {
        const entry = graph[key];
        return !(
          lookedUp.has(key) ||
          (entry && fresh(entry.fetchedAt, GRAPH_TTL_MS))
        );
      });
    if (due.length === 0) return;
    let failed = 0;
    onProgress({ phase: 'related-artists', done: 0, total: due.length });
    for (const [i, { seed, key }] of due.entries()) {
      checkAbort();
      const entry = await fetchEntry(cache, seed).catch(
        unlessAbort(() => null),
      );
      lookedUp.add(key);
      if (entry) {
        graph[key] = entry;
        await graphStore.changed();
      } else {
        failed++;
      }
      onProgress({ phase: 'related-artists', done: i + 1, total: due.length });
    }
    if (failed) onProgress({ phase: 'related-artists-failed', seeds: failed });
  }

  /**
   * A release the week knows from Spotify (a reject or a scouting-playlist
   * album) with Deezer's data when Deezer has it: an album search matched on
   * the artist and a loose title, then the album itself.
   */
  async function withDeezerData(
    cache: DeezerArtistCache,
    known: Candidate,
  ): Promise<Candidate> {
    const artist = await resolveArtist(cache, known.artist);
    const hits = await deezer.searchAlbum(`${known.artist} ${known.title}`);
    const hit = hits.find(
      (h) =>
        (artist
          ? h.artist.id === artist.id
          : sameName(h.artist.name, known.artist)) &&
        sameTitle(h.title, known.title),
    );
    const fans = artist?.fans ?? null;
    if (!hit) return { ...known, artistFans: fans };
    const album = await albumDetail(hit.id);
    const deezerData = await candidate(
      cache,
      { name: known.artist, id: hit.artist.id, fans },
      album,
    );
    // Spotify's title, type and date stay: they're what a pick lands as.
    return {
      ...known,
      ...deezerData,
      title: known.title,
      type: known.type,
      releaseDate: known.releaseDate,
    };
  }

  return {
    async candidates(request, onProgress = () => {}) {
      const cache = await artistStore.load();
      const graph = await graphStore.load();
      const byId = new Map<string, Candidate>();
      const add = (found: Candidate[]) => {
        for (const c of found) {
          // One album can arrive through two artist profiles.
          const seen = byId.get(c.id);
          if (seen) seen.provenance.push(...c.provenance);
          else byId.set(c.id, c);
        }
      };
      try {
        await topUpGraph(cache, graph, request.seeds, onProgress);
        // Seeds and roster artists come through their own searches.
        const known = new Set(
          [...request.seeds, ...request.rosterArtists].map((a) =>
            foldName(a.name),
          ),
        );
        for (const related of coCited(graph, request.seeds, known)) {
          checkAbort();
          add(
            await artistReleases(
              cache,
              related,
              { kind: 'related', to: related.to },
              request.window,
            ).catch(unlessAbort(() => [])),
          );
        }
        for (const roster of request.rosterArtists) {
          checkAbort();
          add(
            await rosterReleases(cache, roster, request.window).catch(
              unlessAbort(() => []),
            ),
          );
        }
        // Releases the week knows from Spotify come back even unmatched.
        const spotifyKnown: Candidate[] = [];
        for (const bare of [
          ...request.rejects.map(bareReject),
          ...bareScouting(request.scouting),
        ]) {
          checkAbort();
          spotifyKnown.push(
            await withDeezerData(cache, bare).catch(unlessAbort(() => bare)),
          );
        }
        return [...byId.values(), ...spotifyKnown];
      } finally {
        await artistStore.save();
        await graphStore.save();
      }
    },
  };
}

type Seed = CandidateRequest['seeds'][number];
type RelatedGraph = Record<string, RelatedArtistEntry>;

/** A seed's graph key: its Spotify id, else its folded name. */
const seedKey = (seed: Seed) => seed.spotifyId ?? foldName(seed.name);

/**
 * The related artists at least `MIN_CO_CITATIONS` of the current seeds
 * name, each with those seeds in seed order. Entries of seeds no longer
 * passed in don't count; `known` names are left out.
 */
function coCited(
  graph: RelatedGraph,
  seeds: Seed[],
  known: Set<string>,
): Array<RelatedArtist & { to: string[] }> {
  const byId = new Map<number, RelatedArtist & { to: string[] }>();
  for (const seed of seeds) {
    for (const artist of graph[seedKey(seed)]?.related ?? []) {
      if (known.has(foldName(artist.name))) continue;
      const seen = byId.get(artist.id);
      if (!seen) byId.set(artist.id, { ...artist, to: [seed.name] });
      else if (!seen.to.includes(seed.name)) seen.to.push(seed.name);
    }
  }
  return [...byId.values()].filter((a) => a.to.length >= MIN_CO_CITATIONS);
}

/**
 * A cache entry held for the adapter's life: loaded on first use, saved
 * every `SAVE_EVERY` changes and when asked.
 */
function batchedStore<T>(
  cache: DurableCache,
  descriptor: CacheDescriptor<T>,
  empty: () => T,
) {
  let value: T | null = null;
  let unsaved = 0;
  async function save(): Promise<void> {
    if (!(value && unsaved)) return;
    unsaved = 0;
    try {
      await cache.save(descriptor, value);
    } catch {
      /* the cache is a speed-up; losing it costs refetches, not the week */
    }
  }
  return {
    async load(): Promise<T> {
      value ??= (await cache.load(descriptor)) ?? empty();
      return value;
    },
    async changed(): Promise<void> {
      if (++unsaved >= SAVE_EVERY) await save();
    },
    save,
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

/**
 * Scouting-playlist albums as the week knows them, before any Deezer data:
 * one per album, with every playlist it's in.
 */
function bareScouting(items: CandidateRequest['scouting']): Candidate[] {
  const byAlbum = new Map<string, Candidate>();
  for (const { playlist, album } of items) {
    const seen = byAlbum.get(album.id);
    const source: CandidateProvenance = { kind: 'scouting', playlist };
    if (!seen) {
      byAlbum.set(album.id, {
        id: `scout-${album.id}`,
        title: album.name,
        artist: album.artistName,
        type: album.albumType,
        trackCount: album.totalTracks,
        releaseDate: album.releaseDate,
        genres: [],
        artistFans: null,
        upc: null,
        relativePopularity: null,
        provenance: [source],
        spotifyAlbumId: album.id,
      });
    } else if (
      !seen.provenance.some(
        (p) => p.kind === 'scouting' && p.playlist === playlist,
      )
    ) {
      seen.provenance.push(source);
    }
  }
  return [...byAlbum.values()];
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
