import fs from 'node:fs';
import { filterByPriority } from '../domain/artists.js';
import { type GenreFilterLists, isGenreAcceptable } from '../domain/filters.js';
import {
  type RawRelease,
  filterLowPopularity,
  filterVariants,
  releaseDateFallbackMatch,
} from '../domain/releases.js';
import {
  generateFridayDates,
  getValidDates,
  parseDate,
} from '../domain/tracks.js';
import { abortableSleep } from '../lib/abort.js';
import { isAuthError } from '../lib/api-wrapper.js';
import {
  getAllPlaylistTracks,
  getAllUserPlaylists,
  getPlaylistAlbums,
} from '../lib/pagination.js';
import { type EventHandlers, ServiceEmitter } from '../lib/service-events.js';
import type { SpotifyContext } from '../lib/spotify-context.js';
import type {
  BatchCache,
  DateResult,
  FoundRelease,
  SimplePlaylist,
  TrustedArtistsFile,
} from '../lib/types.js';
import { PriorityCalculatorService } from './priority-calculator.js';
import { ReleaseCollector, type TrackDedup } from './release-collector.js';

// ── Event map ────────────────────────────────────────────────────────────────

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
  filtered: [
    reason: string,
    artist: string,
    release: string,
    detail?: string,
  ];
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
  cachePath?: string;
  trustedArtistsPath?: string;
  allWeeklyId?: string;
  bestOfAllWeeklyId?: string;
  editorialPlaylists?: Array<{ id: string; name: string }>;
  externalPlaylistSources?: ExternalPlaylistSource[];
  genreFilters?: GenreFilterLists;
  editorialFilter?: EditorialFilterConfig;
}

const DEFAULTS = {
  cachePath: './batch-cache.json',
  trustedArtistsPath: './trusted-artists.json',
  allWeeklyId: '',
  bestOfAllWeeklyId: '',
  editorialPlaylists: [] as Array<{ id: string; name: string }>,
  externalPlaylistSources: [] as ExternalPlaylistSource[],
  editorialFilter: { minPopularity: 60, minFollowers: 100000 },
};

// ── Service ─────────────────────────────────────────────────────────────────

export class PlaylistFillerService {
  private ctx: SpotifyContext;
  private emitter: ServiceEmitter<PlaylistFillerEventMap>;
  private collector: ReleaseCollector;
  private opts: Required<PlaylistFillerOptions>;
  private cache: BatchCache = {};

  constructor(
    ctx: SpotifyContext,
    options?: PlaylistFillerOptions,
    events?: EventHandlers<PlaylistFillerEventMap>,
  ) {
    this.ctx = ctx;
    this.emitter = new ServiceEmitter(events);
    this.collector = new ReleaseCollector(ctx, {
      onVariantPicked: (name, count, isExplicit) =>
        this.emitter.emit('variantPicked', name, count, isExplicit),
      onInstrumentalSkipped: (artist, release) =>
        this.emitter.emit('filtered', 'all-instrumental', artist, release),
      onDeluxeDetected: (name, baseName, origCount, bonus) =>
        this.emitter.emit('deluxeDetected', name, baseName, origCount, bonus),
      onTitleTrackOnly: (releaseName, trackName, oldTracks, totalOther) =>
        this.emitter.emit(
          'titleTrackOnly',
          releaseName,
          trackName,
          oldTracks,
          totalOther,
        ),
      onSingleSkipped: (name) => this.emitter.emit('singleSkipped', name),
    });
    this.opts = {
      freshMode: options?.freshMode ?? false,
      cachePath: options?.cachePath ?? DEFAULTS.cachePath,
      trustedArtistsPath:
        options?.trustedArtistsPath ?? DEFAULTS.trustedArtistsPath,
      allWeeklyId: options?.allWeeklyId ?? DEFAULTS.allWeeklyId,
      bestOfAllWeeklyId:
        options?.bestOfAllWeeklyId ?? DEFAULTS.bestOfAllWeeklyId,
      editorialPlaylists:
        options?.editorialPlaylists ?? DEFAULTS.editorialPlaylists,
      externalPlaylistSources:
        options?.externalPlaylistSources ?? DEFAULTS.externalPlaylistSources,
      genreFilters: options?.genreFilters ?? undefined,
      editorialFilter: options?.editorialFilter ?? DEFAULTS.editorialFilter,
    } as Required<PlaylistFillerOptions>;
  }

  // ── Main entry point ────────────────────────────────────────────────────

  async run(): Promise<DateResult[]> {
    // Get user profile
    const meResult = await this.ctx.call(
      () => this.ctx.api.currentUser.profile(),
      'get user profile',
    );
    if (!meResult.success) {
      if (meResult.authError) {
        await this.ctx.client.runAuth();
        throw new Error('Auth error getting profile. Re-run after auth.');
      }
      throw new Error('Failed to get user profile');
    }
    const userId = meResult.data.id;

    // Load existing playlists
    this.emitter.emit('log', 'Loading playlists to determine date range...');
    const existingPlaylists = await getAllUserPlaylists(this.ctx, userId);
    this.emitter.emit(
      'log',
      `Found ${existingPlaylists.length} user playlists`,
    );

    // Determine dates to process
    const weeklyPattern = /^(\d{2}\.\d{2}\.\d{2})$/;
    const filledDates = new Set<string>();
    const allWeeklyDates = new Set<string>();

    for (const playlist of existingPlaylists) {
      const match = playlist.name.match(weeklyPattern);
      if (match) {
        allWeeklyDates.add(match[1]);
        if (playlist.trackCount > 0) filledDates.add(match[1]);
      }
    }

    let startDate: Date;
    if (allWeeklyDates.size > 0) {
      const sorted = [...allWeeklyDates].sort((a, b) => {
        const da = parseDate(a);
        const db = parseDate(b);
        return da.getTime() - db.getTime();
      });
      startDate = parseDate(sorted[0]);
      this.emitter.emit('log', `Earliest weekly playlist: ${sorted[0]}`);
    } else {
      startDate = new Date(2025, 4, 23);
    }

    const today = new Date();
    const allFridays = generateFridayDates(startDate, today);
    const datesToProcess = allFridays.filter((d) => !filledDates.has(d));

    if (datesToProcess.length === 0) {
      this.emitter.emit('log', 'All weekly playlists are already filled.');
      return [];
    }

    this.emitter.emit('start', datesToProcess);

    // Load / check cache
    if (!this.opts.freshMode) {
      try {
        this.cache = JSON.parse(fs.readFileSync(this.opts.cachePath, 'utf8'));
      } catch {
        this.cache = {};
      }
    }

    // Load All Weekly tracks for dedup
    this.emitter.emit(
      'log',
      'Loading All Weekly tracks for duplicate checking...',
    );
    const allWeeklyTracks = new Set(
      await getAllPlaylistTracks(this.ctx, this.opts.allWeeklyId),
    );
    this.emitter.emit(
      'log',
      `Loaded ${allWeeklyTracks.size} tracks from All Weekly`,
    );

    // Load trusted artists (reloaded after recalculation)
    let trustedArtists: TrustedArtistsFile = JSON.parse(
      fs.readFileSync(this.opts.trustedArtistsPath, 'utf8'),
    );
    let p1p2Artists = filterByPriority(trustedArtists.artistCounts, [1, 2]);
    this.emitter.emit('log', `P1+P2 artists: ${p1p2Artists.length}`);

    // Process each date
    const results: DateResult[] = [];
    const startTime = Date.now();

    for (let i = 0; i < datesToProcess.length; i++) {
      const targetDate = datesToProcess[i];
      this.emitter.emit('dateStart', targetDate, i, datesToProcess.length);

      try {
        // Recalculate priorities if playlists changed (skip if mid-search for this date)
        const recalculated = await this.maybeRecalculate(targetDate);
        if (recalculated) {
          const oldArtists = new Map(
            p1p2Artists.map(([name, data]) => [name, data]),
          );
          trustedArtists = JSON.parse(
            fs.readFileSync(this.opts.trustedArtistsPath, 'utf8'),
          );
          p1p2Artists = filterByPriority(trustedArtists.artistCounts, [1, 2]);
          const newNames = new Set(p1p2Artists.map(([name]) => name));
          const added = p1p2Artists.filter(([name]) => !oldArtists.has(name));
          const removed = [...oldArtists.keys()].filter(
            (name) => !newNames.has(name),
          );
          this.emitter.emit(
            'log',
            `Reloaded P1+P2 artists: ${p1p2Artists.length}`,
          );
          if (added.length) {
            for (const [name, data] of added) {
              const oldData = trustedArtists.artistCounts[name];
              const oldP = oldData?.priority;
              const label = oldP ? `P${oldP}` : 'new';
              this.emitter.emit(
                'log',
                `  + ${name}: ${label} → P${data.priority}`,
              );
            }
          }
          if (removed.length) {
            for (const name of removed) {
              const oldP = oldArtists.get(name)?.priority;
              const newData = trustedArtists.artistCounts[name];
              const newP = newData?.priority ?? null;
              const newLabel = newP ? `P${newP}` : 'none';
              this.emitter.emit('log', `  − ${name}: P${oldP} → ${newLabel}`);
            }
          }
        }

        if (i > 0 && (i + 1) % 10 === 0) {
          await this.ctx.client.refreshToken();
        }

        const result = await this.processDate(
          targetDate,
          p1p2Artists,
          allWeeklyTracks,
          userId,
          existingPlaylists,
          trustedArtists,
        );
        results.push(result);
        this.emitter.emit('dateCompleted', result);

        if (i < datesToProcess.length - 1) {
          await this.sleep(2000);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));

        // Abort errors → propagate immediately, no delay
        if (err.name === 'AbortError' || err.message === 'Stopped by user') {
          throw err;
        }

        this.emitter.emit('dateError', targetDate, err);

        if (isAuthError(err)) {
          const ok = await this.ctx.client.runAuth();
          if (ok) {
            await this.ctx.client.recreateApi();
            i--;
            continue;
          }
          results.push({ date: targetDate, error: err.message } as DateResult);
          break;
        }

        results.push({ date: targetDate, error: err.message } as DateResult);
        await this.sleep(60000);
      }
    }

    const duration = Math.round((Date.now() - startTime) / 1000 / 60);
    this.emitter.emit('batchComplete', results, duration);
    return results;
  }

  // ── Recalculation check ─────────────────────────────────────────────────

  private async maybeRecalculate(targetDate: string): Promise<boolean> {
    const awResult = await this.ctx.call(
      () => this.ctx.api.playlists.getPlaylist(this.opts.allWeeklyId),
      'All Weekly info',
    );
    const boawResult = await this.ctx.call(
      () => this.ctx.api.playlists.getPlaylist(this.opts.bestOfAllWeeklyId),
      'Best of All Weekly info',
    );

    if (!(awResult.success && boawResult.success)) return false;

    const awSnapshot = awResult.data.snapshot_id;
    const boawSnapshot = boawResult.data.snapshot_id;

    const awChanged =
      this.cache.allWeeklySnapshot &&
      this.cache.allWeeklySnapshot !== awSnapshot;
    const boawChanged =
      this.cache.bestOfAllWeeklySnapshot &&
      this.cache.bestOfAllWeeklySnapshot !== boawSnapshot;

    let recalculated = false;
    if (awChanged || boawChanged) {
      const progress = this.cache.artistSearchProgress;
      if (
        progress &&
        progress.date === targetDate &&
        progress.artistsSearched > 0
      ) {
        // Skip recalculation — artist search already in progress for this date
      } else {
        this.emitter.emit('recalculating');
        const calcService = new PriorityCalculatorService(this.ctx, {
          allWeeklyId: this.opts.allWeeklyId,
          bestOfAllWeeklyId: this.opts.bestOfAllWeeklyId,
        });
        const output = await calcService.run();
        fs.writeFileSync(
          this.opts.trustedArtistsPath,
          JSON.stringify(output, null, 2),
        );
        this.emitter.emit('recalculated');
        recalculated = true;
      }
    }

    this.cache.allWeeklySnapshot = awSnapshot;
    this.cache.bestOfAllWeeklySnapshot = boawSnapshot;
    this.saveCache();
    return recalculated;
  }

  private saveCache(): void {
    fs.writeFileSync(this.opts.cachePath, JSON.stringify(this.cache, null, 2));
  }

  // ── Process a single date ───────────────────────────────────────────────

  private async processDate(
    targetDate: string,
    p1p2Artists: Array<[string, { priority: number | null; score: number }]>,
    allWeeklyTracks: Set<string>,
    userId: string,
    existingPlaylists: SimplePlaylist[],
    trustedArtists: TrustedArtistsFile,
  ): Promise<DateResult> {
    const fridayDate = parseDate(targetDate);
    const validDates = getValidDates(fridayDate);
    const playlistName = targetDate;

    // Check existing
    const existing = existingPlaylists.find((p) => p.name === playlistName);

    if (existing && existing.trackCount > 0) {
      this.emitter.emit(
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

    // Create or reuse playlist
    let playlistId: string;
    let playlistUrl: string;

    if (existing) {
      playlistId = existing.id;
      playlistUrl = `https://open.spotify.com/playlist/${existing.id}`;
      this.emitter.emit('playlistReused', targetDate, playlistId);
    } else {
      const createResult = await this.ctx.call(
        () =>
          this.ctx.api.playlists.createPlaylist(userId, {
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
      this.emitter.emit('playlistCreated', targetDate, playlistId);
    }

    // Search P1/P2 artists
    const foundReleases = new Map<string, FoundRelease>();
    let artistsSearched = 0;

    // Resume from cache if available
    const saved = this.cache.artistSearchProgress;
    if (saved && saved.date === targetDate) {
      artistsSearched = saved.artistsSearched;
      for (const [id, release] of Object.entries(saved.foundReleases)) {
        foundReleases.set(id, release);
      }
      this.emitter.emit(
        'log',
        `Resuming from cache: ${artistsSearched}/${p1p2Artists.length} artists searched, ${foundReleases.size} releases found`,
      );
    }

    try {
      for (let ai = artistsSearched; ai < p1p2Artists.length; ai++) {
        const [name, data] = p1p2Artists[ai];
        const artist = await this.collector.searchArtist(name);
        if (!artist) {
          artistsSearched = ai + 1;
          continue;
        }

        const releases = await this.collector.getArtistReleases(artist.id, {
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
            this.emitter.emit('releaseFound', name, release.name, release.type);
          }
        }

        artistsSearched = ai + 1;
        this.emitter.emit(
          'artistSearchProgress',
          artistsSearched,
          p1p2Artists.length,
          name,
        );
        if (artistsSearched % 50 === 0) {
          this.cache.artistSearchProgress = {
            date: targetDate,
            artistsSearched,
            foundReleases: Object.fromEntries(foundReleases),
          };
          this.saveCache();
          this.emitter.emit(
            'artistSearchPause',
            artistsSearched,
            p1p2Artists.length,
          );
        }
      }
    } catch (e) {
      // Save progress on abort so we can resume later
      this.cache.artistSearchProgress = {
        date: targetDate,
        artistsSearched,
        foundReleases: Object.fromEntries(foundReleases),
      };
      this.saveCache();
      throw e;
    }

    this.cache.artistSearchProgress = undefined;
    this.saveCache();

    // Check editorial playlists
    await this.checkEditorialPlaylists(
      targetDate,
      validDates,
      foundReleases,
      trustedArtists,
    );

    // Filter low popularity
    const releasePopularity =
      await this.fetchReleasePopularities(foundReleases);
    const lowPop = filterLowPopularity(foundReleases, releasePopularity);
    for (const id of lowPop) {
      const r = foundReleases.get(id);
      if (!r) continue;
      this.emitter.emit(
        'filtered',
        'low popularity',
        r.artistName,
        r.name,
        `${releasePopularity.get(id)}`,
      );
      foundReleases.delete(id);
    }

    // Filter instrumental/clean variants
    const { filtered: variantIds, removed } = filterVariants(foundReleases);
    for (const { type, release } of removed) {
      this.emitter.emit('filtered', type, release.artistName, release.name);
    }
    for (const id of variantIds) foundReleases.delete(id);

    // Collect tracks
    const { tracksToAdd, addedAlbums, skippedCount } =
      await this.collectAndSortTracks(
        foundReleases,
        allWeeklyTracks,
        releasePopularity,
      );

    // Add tracks to playlist
    if (tracksToAdd.length > 0) {
      for (let i = 0; i < tracksToAdd.length; i += 100) {
        const batch = tracksToAdd.slice(i, i + 100);
        const uris = batch.map((id) => `spotify:track:${id}`);
        const addResult = await this.ctx.call(
          () => this.ctx.api.playlists.addItemsToPlaylist(playlistId, uris),
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

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Sleep in 1-second chunks, checking abort between each. */
  private async sleep(ms: number): Promise<void> {
    await abortableSleep(ms, this.ctx.client);
  }

  private formatExternalDate(targetDate: string, dateFormat: string): string {
    const dd = targetDate.slice(0, 2);
    const mm = targetDate.slice(3, 5);
    const yy = targetDate.slice(6, 8);
    if (dateFormat === 'DD.MM.YYYY') return `${dd}.${mm}.20${yy}`;
    if (dateFormat === 'YYYY-MM-DD') return `20${yy}-${mm}-${dd}`;
    if (dateFormat === 'MM/DD/YYYY') return `${mm}/${dd}/20${yy}`;
    return `${dd}.${mm}.20${yy}`;
  }

  private async checkEditorialPlaylists(
    targetDate: string,
    validDates: string[],
    foundReleases: Map<string, FoundRelease>,
    trustedArtists: TrustedArtistsFile,
  ): Promise<void> {
    const editorialPlaylists = [
      ...(this.opts.editorialPlaylists ?? DEFAULTS.editorialPlaylists),
    ];

    // Find matching playlists from external sources
    const sources =
      this.opts.externalPlaylistSources ?? DEFAULTS.externalPlaylistSources;
    for (const source of sources) {
      const dateStr = this.formatExternalDate(targetDate, source.dateFormat);
      const pattern = new RegExp(source.namePattern);

      const result = await this.ctx.call(
        () => this.ctx.api.playlists.getUsersPlaylists(source.userId, 50, 0),
        `${source.label} playlists`,
      );
      if (!result.success && result.authError) throw result.error;
      if (result.success) {
        const match = result.data.items.find(
          (p: { name: string }) =>
            p.name.includes(dateStr) && pattern.test(p.name),
        );
        if (match) {
          editorialPlaylists.unshift({ id: match.id, name: match.name });
        }
      }
    }

    const editFilter = this.opts.editorialFilter ?? DEFAULTS.editorialFilter;

    const releaseKeys = new Set(
      [...foundReleases.values()].map(
        (r) => `${r.artistName.toLowerCase()}|${r.name.toLowerCase().trim()}`,
      ),
    );

    for (const editorial of editorialPlaylists) {
      const albums = await getPlaylistAlbums(this.ctx, editorial.id);

      for (const [albumId, albumInfo] of albums) {
        if (foundReleases.has(albumId)) continue;

        const infoKey = `${albumInfo.artistName.toLowerCase()}|${albumInfo.name.toLowerCase().trim()}`;
        if (releaseKeys.has(infoKey)) continue;

        const albumResult = await this.ctx.call(
          () => this.ctx.api.albums.get(albumId),
          `album ${albumId}`,
        );
        if (!albumResult.success) {
          if (albumResult.authError) throw albumResult.error;
          continue;
        }
        const album = albumResult.data;
        // Full album endpoint — date is usually day-precision, but handle imprecise as fallback
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
          this.emitter.emit(
            'releaseFound',
            artistName,
            album.name,
            album.album_type,
            editorial.name,
          );
        } else {
          const artistResult = await this.ctx.call(
            () => this.ctx.api.artists.get(primaryArtist.id),
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
            isGenreAcceptable(
              details.genres,
              this.opts.genreFilters ?? undefined,
            )
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
            this.emitter.emit(
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

  private async fetchReleasePopularities(
    releases: Map<string, FoundRelease>,
  ): Promise<Map<string, number>> {
    const popularities = new Map<string, number>();
    const ids = [...releases.keys()];

    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      const result = await this.ctx.call(
        () => this.ctx.api.albums.get(batch),
        'album popularity batch',
      );
      if (result.success) {
        for (const album of result.data) {
          popularities.set(album.id, album.popularity);
        }
      }
    }

    return popularities;
  }

  private async collectAndSortTracks(
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
    const { collected, skippedCount } = await this.collector.collectTracks(
      foundReleases,
      dedup,
    );

    // Build addedAlbums in collection order (albums first)
    const addedAlbums = collected.map((c) => ({
      ...c.release,
      tracksAdded: c.trackIds.length,
    }));

    // Sort by popularity for track ordering
    collected.sort(
      (a, b) =>
        (releasePopularity.get(b.release.id) ?? 0) -
        (releasePopularity.get(a.release.id) ?? 0),
    );
    const tracksToAdd = collected.flatMap((c) => c.trackIds);

    return { tracksToAdd, addedAlbums, skippedCount };
  }
}
