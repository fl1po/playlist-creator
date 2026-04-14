import fs from 'node:fs';
import { filterByPriority } from '../domain/artists.js';
import {
  type RawRelease,
  filterLowPopularity,
  filterVariants,
  releaseDateCouldMatch,
  releaseDateFallbackMatch,
} from '../domain/releases.js';
import { getValidDates, parseDate } from '../domain/tracks.js';
import {
  fetchReleasePopularities,
  getAllPlaylistTracks,
  getNonListenedPlaylists,
  getPlaylistTracksWithArtists,
  invalidateNonListenedCache,
} from '../lib/pagination.js';
import { type EventHandlers, ServiceEmitter } from '../lib/service-events.js';
import type { SpotifyContext } from '../lib/spotify-context.js';
import type {
  FoundRelease,
  SimplePlaylist,
  TrustedArtistsFile,
} from '../lib/types.js';
import { ReleaseCollector, type TrackDedup } from './release-collector.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PriorityChange {
  artist: string;
  from: number | null;
  to: number | null;
}

export type PlaylistSyncEventMap = {
  start: [demotedCount: number, promotedCount: number, playlistCount: number];
  playlistSync: [name: string, removed: number, added: number];
  complete: [totalRemoved: number, totalAdded: number, playlistsSynced: number];
  log: [message: string];
};

export interface PlaylistSyncerOptions {
  allWeeklyId: string;
  trustedArtistsPath: string;
  dataDir: string;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class PlaylistSyncerService {
  private ctx: SpotifyContext;
  private emitter: ServiceEmitter<PlaylistSyncEventMap>;
  private collector: ReleaseCollector;
  private opts: PlaylistSyncerOptions;

  constructor(
    ctx: SpotifyContext,
    options: PlaylistSyncerOptions,
    events?: EventHandlers<PlaylistSyncEventMap>,
  ) {
    this.ctx = ctx;
    this.emitter = new ServiceEmitter(events);
    this.collector = new ReleaseCollector(ctx);
    this.opts = options;
  }

  // ── Main entry ─────────────────────────────────────────────────────────

  async run(changes: PriorityChange[]): Promise<void> {
    const isP1P2 = (p: number | null) => p === 1 || p === 2;
    const demoted = changes.filter((c) => isP1P2(c.from) && !isP1P2(c.to));
    const promoted = changes.filter((c) => !isP1P2(c.from) && isP1P2(c.to));

    if (demoted.length === 0 && promoted.length === 0) {
      this.emitter.emit('log', 'No P1/P2 boundary crossings — skipping sync');
      return;
    }

    if (demoted.length > 0) {
      this.emitter.emit(
        'log',
        `Sync — demoted out of P1/P2: ${demoted.map((d) => d.artist).join(', ')}`,
      );
    }
    if (promoted.length > 0) {
      this.emitter.emit(
        'log',
        `Sync — promoted into P1/P2: ${promoted.map((p) => p.artist).join(', ')}`,
      );
    }

    // Get user profile
    const meResult = await this.ctx.call(
      () => this.ctx.api.currentUser.profile(),
      'get user profile',
    );
    if (!meResult.success) throw new Error('Failed to get user profile');
    const userId = meResult.data.id;

    // Find non-listened weekly playlists
    const { playlists: unprocessed, awTrackIds } =
      await getNonListenedPlaylists(
        this.ctx,
        userId,
        this.opts.allWeeklyId,
        this.opts.dataDir,
        (msg) => this.emitter.emit('log', msg),
      );

    if (unprocessed.length === 0) {
      this.emitter.emit('log', 'No unprocessed weekly playlists found');
      return;
    }

    this.emitter.emit(
      'log',
      `Found ${unprocessed.length} unprocessed playlist(s)`,
    );
    this.emitter.emit('start', demoted.length, promoted.length, unprocessed.length);

    // Load current P1/P2 set for collab checks
    const trustedArtists: TrustedArtistsFile = JSON.parse(
      fs.readFileSync(this.opts.trustedArtistsPath, 'utf8'),
    );
    const p1p2Set = new Set(
      filterByPriority(trustedArtists.artistCounts, [1, 2]).map(
        ([name]) => name,
      ),
    );

    let totalRemoved = 0;
    let totalAdded = 0;
    let playlistsSynced = 0;

    // ── Removal phase ────────────────────────────────────────────────────
    // Only target tracks from demoted artists. Albums are treated as a
    // unit: if any track in the album has a P1/P2 artist, the whole
    // album stays (it was added because of that feature).

    if (demoted.length > 0) {
      const demotedNames = new Set(demoted.map((d) => d.artist.toLowerCase()));

      for (const pl of unprocessed) {
        const tracks = await getPlaylistTracksWithArtists(this.ctx, pl.id);

        // Group tracks by album
        const albumTracks = new Map<string, typeof tracks>();
        for (const track of tracks) {
          const key = track.albumId || track.id;
          if (!albumTracks.has(key)) albumTracks.set(key, []);
          albumTracks.get(key)!.push(track);
        }

        const toRemove: Array<{ uri: string; name: string; artists: string }> =
          [];

        for (const [, albumGroup] of albumTracks) {
          // Skip albums that have no demoted artist
          const albumHasDemoted = albumGroup.some((t) =>
            t.artistNames.some((n) => demotedNames.has(n.toLowerCase())),
          );
          if (!albumHasDemoted) continue;

          // Keep the whole album if any track has a P1/P2 artist
          const albumHasP1P2 = albumGroup.some((t) =>
            t.artistNames.some((n) => p1p2Set.has(n)),
          );
          if (albumHasP1P2) continue;

          for (const track of albumGroup) {
            toRemove.push({
              uri: track.uri,
              name: track.name,
              artists: track.artistNames.join(', '),
            });
          }
        }

        if (toRemove.length > 0) {
          for (let i = 0; i < toRemove.length; i += 100) {
            const batch = toRemove.slice(i, i + 100);
            await this.ctx.call(
              () =>
                this.ctx.api.playlists.removeItemsFromPlaylist(pl.id, {
                  tracks: batch.map((t) => ({ uri: t.uri })),
                }),
              `remove tracks from ${pl.name}`,
            );
          }
          totalRemoved += toRemove.length;
          playlistsSynced++;
          this.emitter.emit('playlistSync', pl.name, toRemove.length, 0);
          for (const t of toRemove) {
            this.emitter.emit(
              'log',
              `  ${pl.name}: removed "${t.artists} — ${t.name}"`,
            );
          }
        }
      }
    }

    // ── Addition phase ───────────────────────────────────────────────────

    if (promoted.length > 0) {
      // Fetch releases for each promoted artist (once, then match against all playlists)
      const artistReleaseCache = new Map<string, RawRelease[]>();

      for (const change of promoted) {
        const artist = await this.collector.searchArtist(change.artist);
        if (!artist) continue;

        const allReleases = await this.collector.getArtistReleases(artist.id, {
          kind: 'all',
        });
        if (allReleases.length > 0) {
          artistReleaseCache.set(change.artist, allReleases);
          this.emitter.emit(
            'log',
            `  Fetched ${allReleases.length} release(s) for ${change.artist}`,
          );
        }
      }

      if (artistReleaseCache.size > 0) {
        for (const pl of unprocessed) {
          const fridayDate = parseDate(pl.name);
          const validDates = getValidDates(fridayDate);

          // Build found releases from cached data
          const foundReleases = new Map<string, FoundRelease>();

          for (const [artistName, releases] of artistReleaseCache) {
            const artistData = trustedArtists.artistCounts[artistName];
            if (!artistData) continue;

            for (const release of releases) {
              if (!this.dateMatches(release.release_date, validDates)) continue;
              if (!foundReleases.has(release.id)) {
                foundReleases.set(release.id, {
                  ...release,
                  artistName,
                  artistSpotifyId: release.artistId,
                  priority: artistData.priority ?? 0,
                  score: artistData.score,
                });
              }
            }
          }

          if (foundReleases.size === 0) continue;

          const popularities = await fetchReleasePopularities(
            this.ctx,
            foundReleases,
          );
          const lowPop = filterLowPopularity(foundReleases, popularities);
          for (const id of lowPop) foundReleases.delete(id);

          const { filtered: variantIds } = filterVariants(foundReleases);
          for (const id of variantIds) foundReleases.delete(id);

          if (foundReleases.size === 0) continue;

          const existingTrackIds = new Set(
            await getAllPlaylistTracks(this.ctx, pl.id),
          );

          const dedup: TrackDedup = {
            excludeIds: new Set([...awTrackIds, ...existingTrackIds]),
            seenIds: new Set(),
            seenKeys: new Set(),
          };
          const { collected } = await this.collector.collectTracks(
            foundReleases,
            dedup,
          );
          const tracksToAdd = collected.flatMap((c) => c.trackIds);

          if (tracksToAdd.length > 0) {
            for (let i = 0; i < tracksToAdd.length; i += 100) {
              const batch = tracksToAdd.slice(i, i + 100);
              const uris = batch.map((id) => `spotify:track:${id}`);
              await this.ctx.call(
                () => this.ctx.api.playlists.addItemsToPlaylist(pl.id, uris),
                `add tracks to ${pl.name}`,
              );
            }
            totalAdded += tracksToAdd.length;
            playlistsSynced++;
            this.emitter.emit('playlistSync', pl.name, 0, tracksToAdd.length);
            this.emitter.emit(
              'log',
              `  ${pl.name}: added ${tracksToAdd.length} track(s) from promoted artists`,
            );
          }
        }
      }
    }

    if (totalRemoved > 0 || totalAdded > 0) {
      invalidateNonListenedCache(this.opts.dataDir);
    }
    this.emitter.emit('complete', totalRemoved, totalAdded, playlistsSynced);
    this.emitter.emit(
      'log',
      `Sync complete: ${totalRemoved} removed, ${totalAdded} added across ${playlistsSynced} playlist(s)`,
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private dateMatches(releaseDate: string, validDates: string[]): boolean {
    if (releaseDate.length === 10) return validDates.includes(releaseDate);
    return (
      releaseDateCouldMatch(releaseDate, validDates) ||
      releaseDateFallbackMatch(releaseDate, validDates)
    );
  }
}
