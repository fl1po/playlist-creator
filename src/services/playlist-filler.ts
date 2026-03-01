import fs from "node:fs";
import { execSync } from "node:child_process";
import type { SpotifyApi } from "@spotify/web-api-ts-sdk";
import { createApiCall, isAuthError } from "../lib/api-wrapper.js";
import {
  getAllPlaylistTracks,
  getAllUserPlaylists,
  getAlbumTracks,
  getPlaylistAlbums,
} from "../lib/pagination.js";
import type {
  ApiCallOptions,
  BatchCache,
  DateResult,
  FoundRelease,
  SimplePlaylist,
  SpotifyClient,
  TrustedArtistsFile,
} from "../lib/types.js";
import { isGenreAcceptable, type GenreFilterLists } from "../domain/filters.js";
import {
  filterLowPopularity,
  filterVariants,
  getBaseAlbumName,
  groupReleases,
  isAllInstrumental,
  isDeluxeRelease,
  type RawRelease,
} from "../domain/releases.js";
import { filterByPriority } from "../domain/artists.js";
import {
  formatDateISO,
  generateFridayDates,
  getValidDates,
  parseDate,
} from "../domain/tracks.js";

// ── Event callbacks ─────────────────────────────────────────────────────────

export interface PlaylistFillerEvents {
  onStart?: (datesToProcess: string[]) => void;
  onDateStart?: (date: string, index: number, total: number) => void;
  onDateSkipped?: (date: string, reason: string, trackCount: number) => void;
  onPlaylistCreated?: (date: string, playlistId: string) => void;
  onPlaylistReused?: (date: string, playlistId: string) => void;
  onArtistSearchProgress?: (searched: number, total: number, artistName: string) => void;
  onArtistSearchPause?: (searched: number, total: number) => void;
  onReleaseFound?: (artist: string, release: string, type: string, source?: string) => void;
  onVariantPicked?: (name: string, variantCount: number, isExplicit: boolean) => void;
  onFiltered?: (reason: string, artist: string, release: string, detail?: string) => void;
  onDeluxeDetected?: (name: string, baseName: string, originalTrackCount: number, bonusTracks: number) => void;
  onSingleSkipped?: (name: string) => void;
  onDateCompleted?: (result: DateResult) => void;
  onDateError?: (date: string, error: Error) => void;
  onRateLimitSleep?: (hours: number, wakeTime: Date) => void;
  onBatchComplete?: (results: DateResult[], durationMinutes: number) => void;
  onRecalculating?: () => void;
  onLog?: (message: string) => void;
}

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
  cachePath: "./batch-cache.json",
  trustedArtistsPath: "./trusted-artists.json",
  allWeeklyId: "",
  bestOfAllWeeklyId: "",
  editorialPlaylists: [] as Array<{ id: string; name: string }>,
  externalPlaylistSources: [] as ExternalPlaylistSource[],
  editorialFilter: { minPopularity: 60, minFollowers: 100000 },
};

// ── Service ─────────────────────────────────────────────────────────────────

export class PlaylistFillerService {
  private client: SpotifyClient;
  private events: PlaylistFillerEvents;
  private opts: Required<PlaylistFillerOptions>;
  private apiCall: ReturnType<typeof createApiCall>;
  private cache: BatchCache = {};

  constructor(
    client: SpotifyClient,
    options?: PlaylistFillerOptions,
    events?: PlaylistFillerEvents,
  ) {
    this.client = client;
    this.events = events ?? {};
    this.opts = {
      freshMode: options?.freshMode ?? false,
      cachePath: options?.cachePath ?? DEFAULTS.cachePath,
      trustedArtistsPath: options?.trustedArtistsPath ?? DEFAULTS.trustedArtistsPath,
      allWeeklyId: options?.allWeeklyId ?? DEFAULTS.allWeeklyId,
      bestOfAllWeeklyId: options?.bestOfAllWeeklyId ?? DEFAULTS.bestOfAllWeeklyId,
      editorialPlaylists: options?.editorialPlaylists ?? DEFAULTS.editorialPlaylists,
      externalPlaylistSources: options?.externalPlaylistSources ?? DEFAULTS.externalPlaylistSources,
      genreFilters: options?.genreFilters ?? undefined,
      editorialFilter: options?.editorialFilter ?? DEFAULTS.editorialFilter,
    } as Required<PlaylistFillerOptions>;

    const apiCallbacks: ApiCallOptions = {
      onRateLimitWait: (s) => this.events.onLog?.(`  Rate limited, waiting ${s / 60}min...`),
      onNetworkRetry: (a, m) => this.events.onLog?.(`  Network error, retry ${a}/${m}`),
      onLongSleep: (h, w) => this.events.onRateLimitSleep?.(h, w),
      onError: (desc, err) => {
        if (err.message?.includes("404")) return;
        this.events.onLog?.(`  Error (${desc}): ${err.message}`);
      },
    };
    this.apiCall = createApiCall(client, apiCallbacks);
  }

  get api(): SpotifyApi {
    return this.client.api;
  }

  // ── Main entry point ────────────────────────────────────────────────────

  async run(): Promise<DateResult[]> {
    // Get user profile
    const meResult = await this.apiCall(
      () => this.api.currentUser.profile(),
      "get user profile",
    );
    if (!meResult.success) {
      if (meResult.authError) {
        await this.client.runAuth();
        throw new Error("Auth error getting profile. Re-run after auth.");
      }
      throw new Error("Failed to get user profile");
    }
    const userId = meResult.data.id;

    // Load existing playlists
    this.events.onLog?.("Loading playlists to determine date range...");
    const existingPlaylists = await getAllUserPlaylists(this.api, userId, this.apiCall);
    this.events.onLog?.(`Found ${existingPlaylists.length} user playlists`);

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
        const da = parseDate(a), db = parseDate(b);
        return da.getTime() - db.getTime();
      });
      startDate = parseDate(sorted[0]);
      this.events.onLog?.(`Earliest weekly playlist: ${sorted[0]}`);
    } else {
      startDate = new Date(2025, 4, 23);
    }

    const today = new Date();
    const allFridays = generateFridayDates(startDate, today);
    const datesToProcess = allFridays.filter((d) => !filledDates.has(d));

    if (datesToProcess.length === 0) {
      this.events.onLog?.("All weekly playlists are already filled.");
      return [];
    }

    this.events.onStart?.(datesToProcess);

    // Load / check cache
    if (!this.opts.freshMode) {
      try {
        this.cache = JSON.parse(fs.readFileSync(this.opts.cachePath, "utf8"));
      } catch {
        this.cache = {};
      }
    }

    // Load All Weekly tracks for dedup
    this.events.onLog?.("Loading All Weekly tracks for duplicate checking...");
    const allWeeklyTracks = new Set(
      await getAllPlaylistTracks(this.api, this.opts.allWeeklyId, this.apiCall),
    );
    this.events.onLog?.(`Loaded ${allWeeklyTracks.size} tracks from All Weekly`);

    // Load trusted artists (reloaded after recalculation)
    let trustedArtists: TrustedArtistsFile = JSON.parse(
      fs.readFileSync(this.opts.trustedArtistsPath, "utf8"),
    );
    let p1p2Artists = filterByPriority(trustedArtists.artistCounts, [1, 2]);
    this.events.onLog?.(`P1+P2 artists: ${p1p2Artists.length}`);

    // Process each date
    const results: DateResult[] = [];
    const startTime = Date.now();

    for (let i = 0; i < datesToProcess.length; i++) {
      const targetDate = datesToProcess[i];
      this.events.onDateStart?.(targetDate, i, datesToProcess.length);

      try {
        // Recalculate priorities if playlists changed (skip if mid-search)
        const recalculated = await this.maybeRecalculate();
        if (recalculated) {
          trustedArtists = JSON.parse(
            fs.readFileSync(this.opts.trustedArtistsPath, "utf8"),
          );
          p1p2Artists = filterByPriority(trustedArtists.artistCounts, [1, 2]);
          this.events.onLog?.(`Reloaded P1+P2 artists: ${p1p2Artists.length}`);
        }

        if (i > 0 && (i + 1) % 10 === 0) {
          await this.client.refreshToken();
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
        this.events.onDateCompleted?.(result);

        if (i < datesToProcess.length - 1) {
          await new Promise((r) => setTimeout(r, 10000));
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));

        // Abort errors → propagate immediately, no delay
        if (err.name === "AbortError" || err.message === "Stopped by user") {
          throw err;
        }

        this.events.onDateError?.(targetDate, err);

        if (isAuthError(err)) {
          const ok = await this.client.runAuth();
          if (ok) {
            await this.client.recreateApi();
            i--;
            continue;
          }
          results.push({ date: targetDate, error: err.message } as DateResult);
          break;
        }

        results.push({ date: targetDate, error: err.message } as DateResult);
        await new Promise((r) => setTimeout(r, 60000));
      }
    }

    const duration = Math.round((Date.now() - startTime) / 1000 / 60);
    this.events.onBatchComplete?.(results, duration);
    return results;
  }

  // ── Recalculation check ─────────────────────────────────────────────────

  private async maybeRecalculate(): Promise<boolean> {
    const awResult = await this.apiCall(
      () => this.api.playlists.getPlaylist(this.opts.allWeeklyId),
      "All Weekly info",
    );
    const boawResult = await this.apiCall(
      () => this.api.playlists.getPlaylist(this.opts.bestOfAllWeeklyId),
      "Best of All Weekly info",
    );

    if (!awResult.success || !boawResult.success) return false;

    const awSnapshot = awResult.data.snapshot_id;
    const boawSnapshot = boawResult.data.snapshot_id;

    const awChanged = this.cache.allWeeklySnapshot && this.cache.allWeeklySnapshot !== awSnapshot;
    const boawChanged = this.cache.bestOfAllWeeklySnapshot && this.cache.bestOfAllWeeklySnapshot !== boawSnapshot;

    let recalculated = false;
    if (awChanged || boawChanged) {
      const progress = this.cache.artistSearchProgress;
      if (progress && progress.artistsSearched > 0) {
        this.events.onLog?.("Playlists changed but skipping recalculation — artist search in progress");
      } else {
        this.events.onRecalculating?.();
        execSync("npm run recalculate", { stdio: "inherit" });
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
      this.events.onDateSkipped?.(targetDate, "already has tracks", existing.trackCount);
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
        reason: "already has tracks",
      };
    }

    // Create or reuse playlist
    let playlistId: string;
    let playlistUrl: string;

    if (existing) {
      playlistId = existing.id;
      playlistUrl = `https://open.spotify.com/playlist/${existing.id}`;
      this.events.onPlaylistReused?.(targetDate, playlistId);
    } else {
      const createResult = await this.apiCall(
        () =>
          this.api.playlists.createPlaylist(userId, {
            name: playlistName,
            description: "Weekly new music releases",
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
      existingPlaylists.push({ id: playlistId, name: playlistName, trackCount: 0 });
      this.events.onPlaylistCreated?.(targetDate, playlistId);
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
      this.events.onLog?.(
        `Resuming from cache: ${artistsSearched}/${p1p2Artists.length} artists searched, ${foundReleases.size} releases found`,
      );
    }

    try {
      for (let ai = artistsSearched; ai < p1p2Artists.length; ai++) {
        const [name, data] = p1p2Artists[ai];
        const artist = await this.searchArtist(name);
        if (!artist) {
          artistsSearched = ai + 1;
          continue;
        }

        const releases = await this.getArtistReleases(artist.id, validDates);

        for (const release of releases) {
          if (!foundReleases.has(release.id)) {
            foundReleases.set(release.id, {
              ...release,
              artistName: name,
              artistSpotifyId: artist.id,
              priority: data.priority!,
              score: data.score,
            });
            this.events.onReleaseFound?.(name, release.name, release.type);
          }
        }

        artistsSearched = ai + 1;
        this.events.onArtistSearchProgress?.(artistsSearched, p1p2Artists.length, name);
        if (artistsSearched % 50 === 0) {
          this.cache.artistSearchProgress = {
            date: targetDate,
            artistsSearched,
            foundReleases: Object.fromEntries(foundReleases),
          };
          this.saveCache();
          this.events.onArtistSearchPause?.(artistsSearched, p1p2Artists.length);
          await new Promise((r) => setTimeout(r, 30000));
        }

        await new Promise((r) => setTimeout(r, 500));
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

    delete this.cache.artistSearchProgress;
    this.saveCache();

    // Check editorial playlists
    await this.checkEditorialPlaylists(
      targetDate,
      validDates,
      foundReleases,
      trustedArtists,
    );

    // Filter low popularity
    const releasePopularity = await this.fetchReleasePopularities(foundReleases);
    const lowPop = filterLowPopularity(foundReleases, releasePopularity);
    for (const id of lowPop) {
      const r = foundReleases.get(id)!;
      this.events.onFiltered?.("low popularity", r.artistName, r.name, `${releasePopularity.get(id)}`);
      foundReleases.delete(id);
    }

    // Filter instrumental/clean variants
    const { filtered: variantIds, removed } = filterVariants(foundReleases);
    for (const { id, type, release } of removed) {
      this.events.onFiltered?.(type, release.artistName, release.name);
    }
    for (const id of variantIds) foundReleases.delete(id);

    // Collect tracks
    const { tracksToAdd, addedAlbums, skippedCount } = await this.collectTracks(
      foundReleases,
      allWeeklyTracks,
      releasePopularity,
    );

    // Add tracks to playlist
    if (tracksToAdd.length > 0) {
      for (let i = 0; i < tracksToAdd.length; i += 100) {
        const batch = tracksToAdd.slice(i, i + 100);
        const uris = batch.map((id) => `spotify:track:${id}`);
        const addResult = await this.apiCall(
          () => this.api.playlists.addItemsToPlaylist(playlistId, uris),
          "add tracks to playlist",
        );
        if (!addResult.success && addResult.authError) throw addResult.error;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const albums = addedAlbums.filter((a) => a.type === "album");
    const singles = addedAlbums.filter((a) => a.type === "single");

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

  private async searchArtist(
    name: string,
  ): Promise<{ id: string; name: string } | null> {
    const result = await this.apiCall(
      () => this.api.search(name, ["artist"], undefined, 5),
      `search "${name}"`,
    );
    if (!result.success) {
      throw result.error ?? new Error(`Search failed for "${name}"`);
    }
    if (result.data.artists?.items.length) {
      const exact = result.data.artists.items.find(
        (a: { name: string }) => a.name.toLowerCase() === name.toLowerCase(),
      );
      const match = exact ?? result.data.artists.items[0];
      return { id: match.id, name: match.name };
    }
    return null;
  }

  private async getArtistReleases(
    artistId: string,
    validDates: string[],
  ): Promise<RawRelease[]> {
    const allReleases: RawRelease[] = [];
    let offset = 0;

    while (true) {
      const result = await this.apiCall(
        () => this.api.artists.albums(artistId, "album,single", undefined, 50, offset),
        `releases for ${artistId}`,
      );
      if (!result.success) {
        if (result.authError) throw result.error;
        return allReleases;
      }

      for (const album of result.data.items) {
        if (validDates.includes(album.release_date)) {
          allReleases.push({
            id: album.id,
            name: album.name,
            type: album.album_type,
            release_date: album.release_date,
            artistId,
            markets: album.available_markets?.length ?? 0,
          });
        }
      }

      if (result.data.items.length < 50) break;
      offset += 50;
      if (offset > 100) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // Deduplicate variants (pick explicit/most markets)
    const groups = groupReleases(allReleases);
    const releases: RawRelease[] = [];

    for (const [, group] of groups) {
      if (group.length === 1) {
        releases.push(group[0]);
        continue;
      }

      let best = group[0];
      let bestIsExplicit = false;
      let bestMarkets = group[0].markets;

      for (const release of group) {
        const info = await this.isAlbumExplicit(release.id);
        if (info.success) {
          if (info.explicit && !bestIsExplicit) {
            best = release;
            bestIsExplicit = true;
            bestMarkets = info.markets;
          } else if (info.explicit === bestIsExplicit && info.markets > bestMarkets) {
            best = release;
            bestMarkets = info.markets;
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      releases.push(best);
      this.events.onVariantPicked?.(best.name, group.length, bestIsExplicit);
    }

    return releases;
  }

  private async isAlbumExplicit(
    albumId: string,
  ): Promise<{ success: boolean; explicit: boolean; markets: number }> {
    const result = await this.apiCall(
      () => this.api.albums.get(albumId),
      `album details ${albumId}`,
    );
    if (!result.success) return { success: false, explicit: false, markets: 0 };

    const hasExplicit = result.data.tracks.items.some(
      (track: { explicit: boolean }) => track.explicit,
    );
    return {
      success: true,
      explicit: hasExplicit,
      markets: result.data.available_markets?.length ?? 0,
    };
  }

  private formatExternalDate(targetDate: string, dateFormat: string): string {
    const dd = targetDate.slice(0, 2);
    const mm = targetDate.slice(3, 5);
    const yy = targetDate.slice(6, 8);
    if (dateFormat === "DD.MM.YYYY") return `${dd}.${mm}.20${yy}`;
    if (dateFormat === "YYYY-MM-DD") return `20${yy}-${mm}-${dd}`;
    if (dateFormat === "MM/DD/YYYY") return `${mm}/${dd}/20${yy}`;
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
    const sources = this.opts.externalPlaylistSources ?? DEFAULTS.externalPlaylistSources;
    for (const source of sources) {
      const dateStr = this.formatExternalDate(targetDate, source.dateFormat);
      const pattern = new RegExp(source.namePattern);

      const result = await this.apiCall(
        () => this.api.playlists.getUsersPlaylists(source.userId, 50, 0),
        `${source.label} playlists`,
      );
      if (result.success) {
        const match = result.data.items.find(
          (p: { name: string }) => p.name.includes(dateStr) && pattern.test(p.name),
        );
        if (match) {
          editorialPlaylists.unshift({ id: match.id, name: match.name });
        }
      }
    }

    const editFilter = this.opts.editorialFilter ?? DEFAULTS.editorialFilter;

    for (const editorial of editorialPlaylists) {
      const albums = await getPlaylistAlbums(this.api, editorial.id, this.apiCall);

      for (const [albumId] of albums) {
        if (foundReleases.has(albumId)) continue;

        const albumResult = await this.apiCall(
          () => this.api.albums.get(albumId),
          `album ${albumId}`,
        );
        if (!albumResult.success) continue;
        const album = albumResult.data;
        if (!validDates.includes(album.release_date)) continue;

        const primaryArtist = album.artists[0];
        const artistName = primaryArtist.name;
        const artistData = trustedArtists.artistCounts[artistName];

        if (artistData && (artistData.priority === 1 || artistData.priority === 2)) {
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
          this.events.onReleaseFound?.(artistName, album.name, album.album_type, editorial.name);
        } else {
          const artistResult = await this.apiCall(
            () => this.api.artists.get(primaryArtist.id),
            `artist ${primaryArtist.id}`,
          );
          if (!artistResult.success) continue;
          const details = artistResult.data;

          if (
            (details.popularity >= editFilter.minPopularity ||
              (details.followers?.total ?? 0) >= editFilter.minFollowers) &&
            isGenreAcceptable(details.genres, this.opts.genreFilters ?? undefined)
          ) {
            foundReleases.set(albumId, {
              id: albumId,
              name: album.name,
              type: album.album_type,
              release_date: album.release_date,
              artistName,
              artistSpotifyId: primaryArtist.id,
              priority: "editorial",
              score: 0,
            });
            this.events.onReleaseFound?.(artistName, album.name, album.album_type, editorial.name);
          }
        }
        await new Promise((r) => setTimeout(r, 50));
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
      const result = await this.apiCall(
        () => this.api.albums.get(batch),
        "album popularity batch",
      );
      if (result.success) {
        for (const album of result.data) {
          popularities.set(album.id, album.popularity);
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    return popularities;
  }

  private async collectTracks(
    foundReleases: Map<string, FoundRelease>,
    allWeeklyTracks: Set<string>,
    releasePopularity: Map<string, number>,
  ): Promise<{
    tracksToAdd: string[];
    addedAlbums: Array<FoundRelease & { tracksAdded: number }>;
    skippedCount: number;
  }> {
    const releaseTrackGroups: Array<{
      albumId: string;
      release: FoundRelease;
      trackIds: string[];
    }> = [];
    const trackIdSet = new Set<string>();
    const trackKeySet = new Set<string>();
    const addedAlbums: Array<FoundRelease & { tracksAdded: number }> = [];
    let skippedCount = 0;

    // Sort: albums first
    const sorted = [...foundReleases.entries()].sort((a, b) => {
      if (a[1].type === "album" && b[1].type !== "album") return -1;
      if (a[1].type !== "album" && b[1].type === "album") return 1;
      return 0;
    });

    for (const [albumId, release] of sorted) {
      const albumTracks = await getAlbumTracks(this.api, albumId, this.apiCall);

      if (albumTracks.length > 0 && isAllInstrumental(albumTracks)) {
        this.events.onFiltered?.("all-instrumental", release.artistName, release.name);
        continue;
      }

      // Deluxe handling
      let originalTrackKeys: Set<string> | null = null;
      if (isDeluxeRelease(release.name)) {
        const baseName = getBaseAlbumName(release.name);
        originalTrackKeys = await this.getOriginalAlbumTrackKeys(
          release.artistSpotifyId,
          baseName,
        );
        if (originalTrackKeys.size > 0) {
          this.events.onDeluxeDetected?.(release.name, baseName, originalTrackKeys.size, 0);
        }
      }

      const currentTracks: string[] = [];
      let addedFromAlbum = 0;
      let skippedFromSingle = 0;
      let skippedFromDeluxe = 0;

      for (const track of albumTracks) {
        if (allWeeklyTracks.has(track.id)) {
          skippedCount++;
          continue;
        }
        if (originalTrackKeys?.has(track.key)) {
          skippedFromDeluxe++;
          skippedCount++;
          continue;
        }
        if (release.type === "single" && trackKeySet.has(track.key)) {
          skippedFromSingle++;
          skippedCount++;
          continue;
        }
        if (trackIdSet.has(track.id)) continue;

        currentTracks.push(track.id);
        trackIdSet.add(track.id);
        trackKeySet.add(track.key);
        addedFromAlbum++;
      }

      if (addedFromAlbum > 0) {
        releaseTrackGroups.push({ albumId, release, trackIds: currentTracks });
        addedAlbums.push({ ...release, tracksAdded: addedFromAlbum });
      } else if (release.type === "single" && skippedFromSingle > 0) {
        this.events.onSingleSkipped?.(release.name);
      }

      if (skippedFromDeluxe > 0 && isDeluxeRelease(release.name)) {
        this.events.onDeluxeDetected?.(
          release.name,
          getBaseAlbumName(release.name),
          skippedFromDeluxe,
          addedFromAlbum,
        );
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    // Sort by popularity, flatten
    releaseTrackGroups.sort(
      (a, b) =>
        (releasePopularity.get(b.albumId) ?? 0) -
        (releasePopularity.get(a.albumId) ?? 0),
    );

    const tracksToAdd = releaseTrackGroups.flatMap((g) => g.trackIds);
    return { tracksToAdd, addedAlbums, skippedCount };
  }

  private async getOriginalAlbumTrackKeys(
    artistId: string,
    baseAlbumName: string,
  ): Promise<Set<string>> {
    const trackKeys = new Set<string>();
    let offset = 0;

    while (offset <= 100) {
      const result = await this.apiCall(
        () => this.api.artists.albums(artistId, "album,single", undefined, 50, offset),
        `search base album for "${baseAlbumName}"`,
      );
      if (!result.success) break;

      for (const album of result.data.items) {
        const albumBase = getBaseAlbumName(album.name);
        if (
          albumBase.toLowerCase() === baseAlbumName.toLowerCase() &&
          !isDeluxeRelease(album.name)
        ) {
          const tracks = await getAlbumTracks(this.api, album.id, this.apiCall);
          for (const track of tracks) trackKeys.add(track.key);
          return trackKeys;
        }
      }

      if (result.data.items.length < 50) break;
      offset += 50;
      await new Promise((r) => setTimeout(r, 100));
    }

    return trackKeys;
  }
}
