import {
  type RawRelease,
  getBaseAlbumName,
  groupReleases,
  isAllInstrumental,
  isDeluxeRelease,
  releaseDateCouldMatch,
  releaseDateFallbackMatch,
} from '../domain/releases.js';
import { getAlbumTracks } from '../lib/pagination.js';
import type { SpotifyContext } from '../lib/spotify-context.js';
import type { FoundRelease } from '../lib/types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type ReleaseFetchMode =
  | { kind: 'filtered'; validDates: string[] }
  | { kind: 'all' };

export interface ReleaseCollectorCallbacks {
  onVariantPicked?: (
    name: string,
    variantCount: number,
    isExplicit: boolean,
  ) => void;
  onInstrumentalSkipped?: (
    artistName: string,
    releaseName: string,
  ) => void;
  onDeluxeDetected?: (
    name: string,
    baseName: string,
    originalTrackCount: number,
    bonusTracks: number,
  ) => void;
  onTitleTrackOnly?: (
    releaseName: string,
    trackName: string,
    oldTracks: number,
    totalOther: number,
  ) => void;
  onSingleSkipped?: (name: string) => void;
}

export interface TrackDedup {
  excludeIds: Set<string>;
  seenIds: Set<string>;
  seenKeys: Set<string>;
}

export interface CollectedRelease {
  release: FoundRelease;
  trackIds: string[];
}

// ── Collector ────────────────────────────────────────────────────────────────

export class ReleaseCollector {
  private ctx: SpotifyContext;
  private cb: ReleaseCollectorCallbacks;

  constructor(ctx: SpotifyContext, callbacks?: ReleaseCollectorCallbacks) {
    this.ctx = ctx;
    this.cb = callbacks ?? {};
  }

  async searchArtist(
    name: string,
  ): Promise<{ id: string; name: string } | null> {
    const result = await this.ctx.call(
      () => this.ctx.api.search(name, ['artist'], undefined, 5),
      `search "${name}"`,
    );
    if (!result.success) {
      if (result.authError)
        throw result.error ?? new Error(`Search failed for "${name}"`);
      return null;
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

  async getArtistReleases(
    artistId: string,
    mode: ReleaseFetchMode,
  ): Promise<RawRelease[]> {
    const allReleases: RawRelease[] = [];
    let offset = 0;

    while (true) {
      const result = await this.ctx.call(
        () =>
          this.ctx.api.artists.albums(
            artistId,
            'album,single',
            undefined,
            50,
            offset,
          ),
        `releases for ${artistId}`,
      );
      if (!result.success) {
        if (result.authError) throw result.error;
        break;
      }

      for (const album of result.data.items) {
        if (mode.kind === 'filtered') {
          let releaseDate = album.release_date;

          if (releaseDate.length === 10) {
            if (!mode.validDates.includes(releaseDate)) continue;
          } else if (releaseDateCouldMatch(releaseDate, mode.validDates)) {
            const fullAlbum = await this.ctx.call(
              () => this.ctx.api.albums.get(album.id),
              `full album ${album.id}`,
            );
            if (
              fullAlbum.success &&
              fullAlbum.data.release_date.length === 10
            ) {
              releaseDate = fullAlbum.data.release_date;
              if (!mode.validDates.includes(releaseDate)) continue;
            } else {
              if (
                !releaseDateFallbackMatch(releaseDate, mode.validDates)
              )
                continue;
            }
          } else {
            continue;
          }

          allReleases.push({
            id: album.id,
            name: album.name,
            type: album.album_type,
            release_date: releaseDate,
            artistId,
            markets: album.available_markets?.length ?? 0,
          });
        } else {
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
          } else if (
            info.explicit === bestIsExplicit &&
            info.markets > bestMarkets
          ) {
            best = release;
            bestMarkets = info.markets;
          }
        }
      }

      releases.push(best);
      this.cb.onVariantPicked?.(best.name, group.length, bestIsExplicit);
    }

    return releases;
  }

  async collectTracks(
    foundReleases: Map<string, FoundRelease>,
    dedup: TrackDedup,
    previousTrackKeysCache?: Map<string, Set<string>>,
  ): Promise<{ collected: CollectedRelease[]; skippedCount: number }> {
    const collected: CollectedRelease[] = [];
    let skippedCount = 0;
    const cache = previousTrackKeysCache ?? new Map<string, Set<string>>();

    // Sort: albums first
    const sorted = [...foundReleases.entries()].sort((a, b) => {
      if (a[1].type === 'album' && b[1].type !== 'album') return -1;
      if (a[1].type !== 'album' && b[1].type === 'album') return 1;
      return 0;
    });

    for (const [albumId, release] of sorted) {
      const albumTracks = await getAlbumTracks(this.ctx, albumId);

      if (albumTracks.length > 0 && isAllInstrumental(albumTracks)) {
        this.cb.onInstrumentalSkipped?.(release.artistName, release.name);
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
          this.cb.onDeluxeDetected?.(
            release.name,
            baseName,
            originalTrackKeys.size,
            0,
          );
        }
      }

      // Title-track detection
      let titleTrackOnly: string | null = null;
      if (albumTracks.length > 1) {
        const titleTrack = albumTracks.find(
          (t) => t.name.toLowerCase() === release.name.toLowerCase(),
        );
        if (titleTrack) {
          const previousKeys = await this.getArtistPreviousTrackKeys(
            release.artistSpotifyId,
            release.release_date,
            cache,
          );
          if (previousKeys.size > 0) {
            const otherTracks = albumTracks.filter(
              (t) => t.id !== titleTrack.id,
            );
            const oldCount = otherTracks.filter((t) =>
              previousKeys.has(t.key),
            ).length;
            if (oldCount > otherTracks.length / 2) {
              titleTrackOnly = titleTrack.id;
              this.cb.onTitleTrackOnly?.(
                release.name,
                titleTrack.name,
                oldCount,
                otherTracks.length,
              );
            }
          }
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
        if (dedup.excludeIds.has(track.id)) {
          skippedCount++;
          continue;
        }
        if (originalTrackKeys?.has(track.key)) {
          skippedFromDeluxe++;
          skippedCount++;
          continue;
        }
        if (release.type === 'single' && dedup.seenKeys.has(track.key)) {
          skippedFromSingle++;
          skippedCount++;
          continue;
        }
        if (dedup.seenIds.has(track.id)) continue;

        currentTracks.push(track.id);
        dedup.seenIds.add(track.id);
        dedup.seenKeys.add(track.key);
      }

      if (currentTracks.length > 0) {
        collected.push({ release, trackIds: currentTracks });
      } else if (release.type === 'single' && skippedFromSingle > 0) {
        this.cb.onSingleSkipped?.(release.name);
      }

      if (skippedFromDeluxe > 0 && isDeluxeRelease(release.name)) {
        this.cb.onDeluxeDetected?.(
          release.name,
          getBaseAlbumName(release.name),
          skippedFromDeluxe,
          currentTracks.length,
        );
      }
    }

    return { collected, skippedCount };
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private async isAlbumExplicit(
    albumId: string,
  ): Promise<{ success: boolean; explicit: boolean; markets: number }> {
    const result = await this.ctx.call(
      () => this.ctx.api.albums.get(albumId),
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

  private async getOriginalAlbumTrackKeys(
    artistId: string,
    baseAlbumName: string,
  ): Promise<Set<string>> {
    const trackKeys = new Set<string>();
    let offset = 0;

    while (offset <= 100) {
      const result = await this.ctx.call(
        () =>
          this.ctx.api.artists.albums(
            artistId,
            'album,single',
            undefined,
            50,
            offset,
          ),
        `search base album for "${baseAlbumName}"`,
      );
      if (!result.success) break;

      for (const album of result.data.items) {
        const albumBase = getBaseAlbumName(album.name);
        if (
          albumBase.toLowerCase() === baseAlbumName.toLowerCase() &&
          !isDeluxeRelease(album.name)
        ) {
          const tracks = await getAlbumTracks(this.ctx, album.id);
          for (const track of tracks) trackKeys.add(track.key);
          return trackKeys;
        }
      }

      if (result.data.items.length < 50) break;
      offset += 50;
    }

    return trackKeys;
  }

  private async getArtistPreviousTrackKeys(
    artistId: string,
    beforeDate: string,
    cache: Map<string, Set<string>>,
  ): Promise<Set<string>> {
    const cached = cache.get(artistId);
    if (cached) return cached;

    const trackKeys = new Set<string>();
    let offset = 0;
    let albumsFetched = 0;

    outer: while (offset <= 100) {
      const result = await this.ctx.call(
        () =>
          this.ctx.api.artists.albums(
            artistId,
            'album,single',
            undefined,
            50,
            offset,
          ),
        `older releases for ${artistId}`,
      );
      if (!result.success) break;

      for (const album of result.data.items) {
        if (album.album_type !== 'album') continue;
        if (album.release_date >= beforeDate) continue;

        const tracks = await getAlbumTracks(this.ctx, album.id);
        for (const track of tracks) trackKeys.add(track.key);
        albumsFetched++;
        if (albumsFetched >= 3) break outer;
      }

      if (result.data.items.length < 50) break;
      offset += 50;
    }

    cache.set(artistId, trackKeys);
    return trackKeys;
  }
}
