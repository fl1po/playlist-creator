import type { GenreFilterLists } from '../../domain/filters.js';
import type { ServiceEmitter } from '../../lib/service-events.js';
import type { SpotifyContext } from '../../lib/spotify-context.js';
import type {
  DateResult,
  SimplePlaylist,
  TrustedArtistsFile,
} from '../../lib/types.js';
import {
  type CollectionDecision,
  type WeekCollectionPorts,
  type WeekProgressEvent,
  collectWeek,
} from '../week-collection/index.js';
import type {
  EditorialFilterConfig,
  ExternalPlaylistSource,
  PlaylistFillerEventMap,
} from './events.js';

export interface DatePipelineConfig {
  editorialPlaylists: Array<{ id: string; name: string }>;
  externalPlaylistSources: ExternalPlaylistSource[];
  editorialFilter: EditorialFilterConfig;
  genreFilters?: GenreFilterLists;
}

export interface DatePipelineDeps {
  ctx: SpotifyContext;
  emitter: ServiceEmitter<PlaylistFillerEventMap>;
  ports: WeekCollectionPorts;
  config: DatePipelineConfig;
}

type Emitter = ServiceEmitter<PlaylistFillerEventMap>;

/** Map week-collection liveness onto the existing event map. */
function emitProgress(emitter: Emitter, e: WeekProgressEvent): void {
  switch (e.phase) {
    case 'resumed':
      emitter.emit(
        'log',
        `Resuming from cache: ${e.searched}/${e.total} artists searched, ${e.found} releases found`,
      );
      break;
    case 'searching':
      emitter.emit('artistSearchProgress', e.searched, e.total, e.artist);
      break;
    case 'release-found':
      emitter.emit('releaseFound', e.artist, e.release, e.type, e.source);
      break;
    case 'checkpoint':
      emitter.emit('artistSearchPause', e.searched, e.total);
      break;
    case 'popularity':
      emitter.emit('log', `Checking popularity: ${e.done}/${e.total}`);
      break;
    default:
      break;
  }
}

/** Map collection decisions onto the existing event map. */
function emitDecision(emitter: Emitter, d: CollectionDecision): void {
  switch (d.kind) {
    case 'release-found':
      // Logged live during search/editorial via emitProgress; skip here so the
      // end-of-date decision replay doesn't double-log each find.
      break;
    case 'variant-picked':
      emitter.emit('variantPicked', d.release, d.variantCount, d.explicit);
      break;
    case 'variant-stripped':
      emitter.emit('filtered', d.reason, d.artist, d.release);
      break;
    case 'low-popularity':
      emitter.emit(
        'filtered',
        'low popularity',
        d.artist,
        d.release,
        `${d.popularity}`,
      );
      break;
    case 'deluxe-stripped':
      emitter.emit(
        'deluxeDetected',
        d.release,
        d.baseName,
        d.originalTrackCount,
        d.bonusTracks,
      );
      break;
    case 'title-track-only':
      emitter.emit(
        'titleTrackOnly',
        d.release,
        d.track,
        d.oldTracks,
        d.otherTracks,
      );
      break;
    case 'single-skipped':
      emitter.emit('singleSkipped', d.release);
      break;
  }
}

/**
 * Fill one weekly playlist: resolve the playlist (skip / reuse / create),
 * run the week collection, render its decisions as events, write the tracks.
 */
export async function processDate(
  deps: DatePipelineDeps,
  targetDate: string,
  p1p2Artists: Array<
    [
      string,
      { priority: number | null; score: number; spotifyId?: string | null },
    ]
  >,
  allWeeklyTracks: Set<string>,
  userId: string,
  existingPlaylists: SimplePlaylist[],
  trustedArtists: TrustedArtistsFile,
): Promise<DateResult> {
  const { ctx, emitter, ports, config } = deps;
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

  const week = await collectWeek(
    {
      week: targetDate,
      roster: p1p2Artists,
      trustedArtists,
      listeningHistory: allWeeklyTracks,
      editorial: {
        playlists: config.editorialPlaylists,
        externalSources: config.externalPlaylistSources,
        gate: config.editorialFilter,
        genreFilters: config.genreFilters,
      },
    },
    ports,
    (e) => emitProgress(emitter, e),
  );

  for (const d of week.decisions) emitDecision(emitter, d);

  if (week.tracks.length > 0) {
    for (let i = 0; i < week.tracks.length; i += 100) {
      const batch = week.tracks.slice(i, i + 100);
      const uris = batch.map((id) => `spotify:track:${id}`);
      const addResult = await ctx.call(
        () => ctx.api.playlists.addItemsToPlaylist(playlistId, uris),
        'add tracks to playlist',
      );
      if (!addResult.success && addResult.authError) throw addResult.error;
    }
  }

  const albums = week.releases.filter((a) => a.type === 'album');
  const singles = week.releases.filter((a) => a.type === 'single');

  return {
    date: targetDate,
    playlistId,
    playlistUrl,
    tracksAdded: week.tracks.length,
    albumsCount: albums.length,
    singlesCount: singles.length,
    skippedCount: week.skippedCount,
    releases: week.releases,
  };
}
