import type { DateResult } from '../../lib/types.js';

export type PlaylistFillerEventMap = {
  start: [datesToProcess: string[]];
  dateStart: [date: string, index: number, total: number];
  dateSkipped: [date: string, reason: string, trackCount: number];
  playlistCreated: [date: string, playlistId: string];
  playlistReused: [date: string, playlistId: string];
  artistSearchProgress: [searched: number, total: number, artistName: string];
  artistSearchPause: [searched: number, total: number];
  releaseFound: [
    artist: string,
    release: string,
    type: string,
    source?: string,
  ];
  variantPicked: [name: string, variantCount: number, isExplicit: boolean];
  filtered: [reason: string, artist: string, release: string, detail?: string];
  deluxeDetected: [
    name: string,
    baseName: string,
    originalTrackCount: number,
    bonusTracks: number,
  ];
  titleTrackOnly: [
    releaseName: string,
    trackName: string,
    oldTracks: number,
    totalOther: number,
  ];
  singleSkipped: [name: string];
  dateCompleted: [result: DateResult];
  dateError: [date: string, error: Error];
  rateLimitSleep: [hours: number, wakeTime: Date];
  rateLimitWait: [seconds: number, wakeTime: Date];
  batchComplete: [results: DateResult[], durationMinutes: number];
  recalculating: [];
  recalculated: [];
  pacerWait: [intervalMs: number];
  log: [message: string];
};

export interface ExternalPlaylistSource {
  userId: string;
  namePattern: string;
  dateFormat: string;
  label: string;
}

export interface EditorialFilterConfig {
  minPopularity: number;
  minFollowers: number;
}

export interface PlaylistFillerOptions {
  freshMode?: boolean;
  allWeeklyId?: string;
  bestOfAllWeeklyId?: string;
  useLikedSongs?: boolean;
  editorialPlaylists?: Array<{ id: string; name: string }>;
  externalPlaylistSources?: ExternalPlaylistSource[];
  genreFilters?: import('../../domain/filters.js').GenreFilterLists;
  editorialFilter?: EditorialFilterConfig;
}
