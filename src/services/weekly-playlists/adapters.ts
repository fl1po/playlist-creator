import {
  getAllPlaylistTracks,
  getAllUserPlaylists,
} from '../../lib/pagination.js';
import type { SpotifyGateway } from '../../lib/spotify/gateway.js';
import type { SimplePlaylist } from '../../lib/types.js';
import { spotifyPlaylistWrites } from '../promotion-sync/adapters.js';
import type { WeeklyPlaylistStore } from './index.js';

/**
 * Production WeeklyPlaylistStore over SpotifyGateway + pagination. Track
 * writes reuse promotion sync's adapter (100-item chunks, uri formatting).
 */
export function spotifyWeeklyPlaylistStore(
  ctx: SpotifyGateway,
): WeeklyPlaylistStore {
  const writes = spotifyPlaylistWrites(ctx);
  return {
    list(userId, onProgress) {
      return getAllUserPlaylists(ctx, userId, { onProgress });
    },
    async create(userId, name) {
      const result = await ctx.call(
        (api) =>
          api.playlists.createPlaylist(userId, {
            name,
            description: 'Weekly new music releases',
            public: false,
          }),
        `create playlist ${name}`,
      );
      if (!result.success) {
        throw new Error(`Failed to create playlist for ${name}`);
      }
      return { id: result.data.id, url: result.data.external_urls.spotify };
    },
    addTracks: writes.addTracks,
    trackIds(playlistId) {
      return getAllPlaylistTracks(ctx, playlistId);
    },
  };
}

/**
 * In-memory WeeklyPlaylistStore for tests: a listing plus a record of every
 * create and add. `calls` receives the same log, so a test can check ordering
 * against other ports that share it.
 *
 * Playlists hold track ids (`tracks`, seeded with `trackCount` placeholder ids
 * unless given) and a snapshot id that changes on every add or `edit`, the way
 * Spotify's does. `edit` stands in for a change made outside the app.
 * `trackReads` lists each playlist whose tracks were read, in order.
 */
export function memoryWeeklyPlaylistStore(
  initial: SimplePlaylist[],
  calls: string[] = [],
  tracks: Record<string, string[]> = {},
): WeeklyPlaylistStore & {
  created: SimplePlaylist[];
  added: Map<string, string[]>;
  trackReads: string[];
  edit(playlistId: string, trackIds: string[]): void;
  failAddWith?: Error;
} {
  const playlists = initial.map((p) => ({ ...p }));
  const contents = new Map<string, string[]>(Object.entries(tracks));
  for (const p of playlists) {
    if (!contents.has(p.id))
      contents.set(
        p.id,
        Array.from({ length: p.trackCount }, (_, i) => `${p.id}-t${i + 1}`),
      );
  }
  const versions = new Map<string, number>();
  const bump = (playlistId: string) =>
    versions.set(playlistId, (versions.get(playlistId) ?? 0) + 1);
  const created: SimplePlaylist[] = [];
  const added = new Map<string, string[]>();
  const trackReads: string[] = [];
  return {
    created,
    added,
    trackReads,
    async list(_userId, onProgress) {
      onProgress?.(playlists.length, playlists.length);
      return playlists.map((p) => ({
        ...p,
        snapshotId: `${p.id}@${versions.get(p.id) ?? 0}`,
      }));
    },
    async create(_userId, name) {
      const playlist = { id: `pl-${created.length + 1}`, name, trackCount: 0 };
      playlists.push(playlist);
      contents.set(playlist.id, []);
      created.push(playlist);
      calls.push(`create ${name}`);
      return {
        id: playlist.id,
        url: `https://open.spotify.com/playlist/${playlist.id}`,
      };
    },
    async addTracks(playlistId, trackIds) {
      calls.push(`add ${playlistId}`);
      if (this.failAddWith) throw this.failAddWith;
      added.set(playlistId, [...(added.get(playlistId) ?? []), ...trackIds]);
      contents.set(playlistId, [
        ...(contents.get(playlistId) ?? []),
        ...trackIds,
      ]);
      const playlist = playlists.find((p) => p.id === playlistId);
      if (playlist) playlist.trackCount += trackIds.length;
      bump(playlistId);
    },
    async trackIds(playlistId) {
      trackReads.push(playlistId);
      return [...(contents.get(playlistId) ?? [])];
    },
    edit(playlistId, trackIds) {
      contents.set(playlistId, [...trackIds]);
      const playlist = playlists.find((p) => p.id === playlistId);
      if (playlist) playlist.trackCount = trackIds.length;
      bump(playlistId);
    },
  };
}
