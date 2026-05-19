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
import { fetchDeezerPopularities } from '../../lib/deezer-popularity.js';
import { getPlaylistAlbums } from '../../lib/pagination.js';
import type { ServiceEmitter } from '../../lib/service-events.js';
import type { SpotifyContext } from '../../lib/spotify-context.js';
import type {
  BatchCache,
  DateResult,
  FoundRelease,
  SimplePlaylist,
  TrustedArtistsFile,
} from '../../lib/types.js';
import type { ReleaseCollector, TrackDedup } from '../release-collector.js';
import type {
  EditorialFilterConfig,
  ExternalPlaylistSource,
  PlaylistFillerEventMap,
} from './events.js';
import type { FillStorage } from './storage.js';

export interface DatePipelineConfig {
  editorialPlaylists: Array<{ id: string; name: string }>;
  externalPlaylistSources: ExternalPlaylistSource[];
  editorialFilter: EditorialFilterConfig;
  genreFilters?: GenreFilterLists;
}

export interface DatePipelineDeps {
  ctx: SpotifyContext;
  storage: FillStorage;
  emitter: ServiceEmitter<PlaylistFillerEventMap>;
  collector: ReleaseCollector;
  config: DatePipelineConfig;
}

function formatExternalDate(targetDate: string, dateFormat: string): string {
  const dd = targetDate.slice(0, 2);
  const mm = targetDate.slice(3, 5);
  const yy = targetDate.slice(6, 8);
  if (dateFormat === 'DD.MM.YYYY') return `${dd}.${mm}.20${yy}`;
  if (dateFormat === 'YYYY-MM-DD') return `20${yy}-${mm}-${dd}`;
  if (dateFormat === 'MM/DD/YYYY') return `${mm}/${dd}/20${yy}`;
  return `${dd}.${mm}.20${yy}`;
}

async function checkEditorialPlaylists(
  deps: DatePipelineDeps,
  targetDate: string,
  validDates: string[],
  foundReleases: Map<string, FoundRelease>,
  trustedArtists: TrustedArtistsFile,
): Promise<void> {
  const { ctx, emitter, config } = deps;
  const editorialPlaylists = [...config.editorialPlaylists];

  for (const source of config.externalPlaylistSources) {
    const dateStr = formatExternalDate(targetDate, source.dateFormat);
    const pattern = new RegExp(source.namePattern);
    const result = await ctx.call(
      () => ctx.api.playlists.getUsersPlaylists(source.userId, 50, 0),
      `${source.label} playlists`,
    );
    if (!result.success && result.authError) throw result.error;
    if (result.success) {
      const match = result.data.items.find(
        (p: { name: string }) =>
          p.name.includes(dateStr) && pattern.test(p.name),
      );
      if (match) editorialPlaylists.unshift({ id: match.id, name: match.name });
    }
  }

  const editFilter = config.editorialFilter;
  const releaseKeys = new Set(
    [...foundReleases.values()].map(
      (r) => `${r.artistName.toLowerCase()}|${r.name.toLowerCase().trim()}`,
    ),
  );

  for (const editorial of editorialPlaylists) {
    const albums = await getPlaylistAlbums(ctx, editorial.id);
    for (const [albumId, albumInfo] of albums) {
      if (foundReleases.has(albumId)) continue;
      const infoKey = `${albumInfo.artistName.toLowerCase()}|${albumInfo.name.toLowerCase().trim()}`;
      if (releaseKeys.has(infoKey)) continue;

      const albumResult = await ctx.call(
        () => ctx.api.albums.get(albumId),
        `album ${albumId}`,
      );
      if (!albumResult.success) {
        if (albumResult.authError) throw albumResult.error;
        continue;
      }
      const album = albumResult.data;
      const editRd = album.release_date;
      if (editRd.length === 10) {
        if (!validDates.includes(editRd)) continue;
      } else if (!releaseDateFallbackMatch(editRd, validDates)) {
        continue;
      }

      const primaryArtist = album.artists[0];
      const artistName = primaryArtist.name;
      const artistData = trustedArtists.artistCounts[artistName];

      if (
        artistData &&
        (artistData.priority === 1 || artistData.priority === 2)
      ) {
        foundReleases.set(albumId, {
          id: albumId,
          name: album.name,
          type: album.album_type,
          release_date: album.release_date,
          artistName,
          artistSpotifyId: primaryArtist.id,
          priority: artistData.priority,
          score: artistData.score,
        });
        releaseKeys.add(
          `${artistName.toLowerCase()}|${album.name.toLowerCase().trim()}`,
        );
        emitter.emit(
          'releaseFound',
          artistName,
          album.name,
          album.album_type,
          editorial.name,
        );
      } else {
        const artistResult = await ctx.call(
          () => ctx.api.artists.get(primaryArtist.id),
          `artist ${primaryArtist.id}`,
        );
        if (!artistResult.success) {
          if (artistResult.authError) throw artistResult.error;
          continue;
        }
        const details = artistResult.data;
        if (
          (details.popularity >= editFilter.minPopularity ||
            (details.followers?.total ?? 0) >= editFilter.minFollowers) &&
          isGenreAcceptable(details.genres, config.genreFilters)
        ) {
          foundReleases.set(albumId, {
            id: albumId,
            name: album.name,
            type: album.album_type,
            release_date: album.release_date,
            artistName,
            artistSpotifyId: primaryArtist.id,
            priority: 'editorial',
            score: 0,
          });
          releaseKeys.add(
            `${artistName.toLowerCase()}|${album.name.toLowerCase().trim()}`,
          );
          emitter.emit(
            'releaseFound',
            artistName,
            album.name,
            album.album_type,
            editorial.name,
          );
        }
      }
    }
  }
}

async function collectAndSortTracks(
  deps: DatePipelineDeps,
  foundReleases: Map<string, FoundRelease>,
  allWeeklyTracks: Set<string>,
  releasePopularity: Map<string, number>,
): Promise<{
  tracksToAdd: string[];
  addedAlbums: Array<FoundRelease & { tracksAdded: number }>;
  skippedCount: number;
}> {
  const dedup: TrackDedup = {
    excludeIds: allWeeklyTracks,
    seenIds: new Set(),
    seenKeys: new Set(),
  };
  const { collected, skippedCount } = await deps.collector.collectTracks(
    foundReleases,
    dedup,
  );
  const addedAlbums = collected.map((c) => ({
    ...c.release,
    tracksAdded: c.trackIds.length,
  }));
  collected.sort(
    (a, b) =>
      (releasePopularity.get(b.release.id) ?? 0) -
      (releasePopularity.get(a.release.id) ?? 0),
  );
  const tracksToAdd = collected.flatMap((c) => c.trackIds);
  return { tracksToAdd, addedAlbums, skippedCount };
}

export async function processDate(
  deps: DatePipelineDeps,
  cache: BatchCache,
  targetDate: string,
  p1p2Artists: Array<[string, { priority: number | null; score: number }]>,
  allWeeklyTracks: Set<string>,
  userId: string,
  existingPlaylists: SimplePlaylist[],
  trustedArtists: TrustedArtistsFile,
): Promise<DateResult> {
  const { ctx, storage, emitter, collector } = deps;
  const fridayDate = parseDate(targetDate);
  const validDates = getValidDates(fridayDate);
  const playlistName = targetDate;

  const existing = existingPlaylists.find((p) => p.name === playlistName);
  if (existing && existing.trackCount > 0) {
    emitter.emit(
      'dateSkipped',
      targetDate,
      'already has tracks',
      existing.trackCount,
    );
    return {
      date: targetDate,
      playlistId: existing.id,
      playlistUrl: `https://open.spotify.com/playlist/${existing.id}`,
      tracksAdded: existing.trackCount,
      albumsCount: 0,
      singlesCount: 0,
      skippedCount: 0,
      releases: [],
      skipped: true,
      reason: 'already has tracks',
    };
  }

  let playlistId: string;
  let playlistUrl: string;
  if (existing) {
    playlistId = existing.id;
    playlistUrl = `https://open.spotify.com/playlist/${existing.id}`;
    emitter.emit('playlistReused', targetDate, playlistId);
  } else {
    const createResult = await ctx.call(
      () =>
        ctx.api.playlists.createPlaylist(userId, {
          name: playlistName,
          description: 'Weekly new music releases',
          public: false,
        }),
      `create playlist ${targetDate}`,
    );
    if (!createResult.success) {
      if (createResult.authError) throw createResult.error;
      throw new Error(`Failed to create playlist for ${targetDate}`);
    }
    playlistId = createResult.data.id;
    playlistUrl = createResult.data.external_urls.spotify;
    existingPlaylists.push({
      id: playlistId,
      name: playlistName,
      trackCount: 0,
    });
    emitter.emit('playlistCreated', targetDate, playlistId);
  }

  // Search P1/P2 artists (with resume-from-cache)
  const foundReleases = new Map<string, FoundRelease>();
  let artistsSearched = 0;
  const saved = cache.artistSearchProgress;
  if (saved && saved.date === targetDate) {
    artistsSearched = saved.artistsSearched;
    for (const [id, release] of Object.entries(saved.foundReleases)) {
      foundReleases.set(id, release);
    }
    emitter.emit(
      'log',
      `Resuming from cache: ${artistsSearched}/${p1p2Artists.length} artists searched, ${foundReleases.size} releases found`,
    );
  }

  try {
    for (let ai = artistsSearched; ai < p1p2Artists.length; ai++) {
      const [name, data] = p1p2Artists[ai];
      const artist = await collector.searchArtist(name);
      if (!artist) {
        artistsSearched = ai + 1;
        continue;
      }
      const releases = await collector.getArtistReleases(artist.id, {
        kind: 'filtered',
        validDates,
      });
      for (const release of releases) {
        if (!foundReleases.has(release.id)) {
          foundReleases.set(release.id, {
            ...release,
            artistName: name,
            artistSpotifyId: artist.id,
            priority: data.priority ?? 0,
            score: data.score,
          });
          emitter.emit('releaseFound', name, release.name, release.type);
        }
      }
      artistsSearched = ai + 1;
      emitter.emit(
        'artistSearchProgress',
        artistsSearched,
        p1p2Artists.length,
        name,
      );
      if (artistsSearched % 50 === 0) {
        cache.artistSearchProgress = {
          date: targetDate,
          artistsSearched,
          foundReleases: Object.fromEntries(foundReleases),
        };
        await storage.saveBatchCache(cache);
        emitter.emit('artistSearchPause', artistsSearched, p1p2Artists.length);
      }
    }
  } catch (e) {
    cache.artistSearchProgress = {
      date: targetDate,
      artistsSearched,
      foundReleases: Object.fromEntries(foundReleases),
    };
    await storage.saveBatchCache(cache);
    throw e;
  }

  cache.artistSearchProgress = undefined;
  await storage.saveBatchCache(cache);

  await checkEditorialPlaylists(
    deps,
    targetDate,
    validDates,
    foundReleases,
    trustedArtists,
  );

  const releasePopularity = await fetchDeezerPopularities(foundReleases, {
    onProgress: (done, total) =>
      emitter.emit('log', `Checking popularity: ${done}/${total}`),
  });
  const lowPop = filterLowPopularity(foundReleases, releasePopularity);
  for (const id of lowPop) {
    const r = foundReleases.get(id);
    if (!r) continue;
    emitter.emit(
      'filtered',
      'low popularity',
      r.artistName,
      r.name,
      `${releasePopularity.get(id)}`,
    );
    foundReleases.delete(id);
  }

  const { filtered: variantIds, removed } = filterVariants(foundReleases);
  for (const { type, release } of removed) {
    emitter.emit('filtered', type, release.artistName, release.name);
  }
  for (const id of variantIds) foundReleases.delete(id);

  const { tracksToAdd, addedAlbums, skippedCount } = await collectAndSortTracks(
    deps,
    foundReleases,
    allWeeklyTracks,
    releasePopularity,
  );

  if (tracksToAdd.length > 0) {
    for (let i = 0; i < tracksToAdd.length; i += 100) {
      const batch = tracksToAdd.slice(i, i + 100);
      const uris = batch.map((id) => `spotify:track:${id}`);
      const addResult = await ctx.call(
        () => ctx.api.playlists.addItemsToPlaylist(playlistId, uris),
        'add tracks to playlist',
      );
      if (!addResult.success && addResult.authError) throw addResult.error;
    }
  }

  const albums = addedAlbums.filter((a) => a.type === 'album');
  const singles = addedAlbums.filter((a) => a.type === 'single');

  return {
    date: targetDate,
    playlistId,
    playlistUrl,
    tracksAdded: tracksToAdd.length,
    albumsCount: albums.length,
    singlesCount: singles.length,
    skippedCount,
    releases: addedAlbums,
  };
}
