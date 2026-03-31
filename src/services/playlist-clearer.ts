import { type EventHandlers, ServiceEmitter } from '../lib/service-events.js';
import type { SpotifyContext } from '../lib/spotify-context.js';

// ── Events ──────────────────────────────────────────────────────────────────

export type PlaylistClearerEventMap = {
  playlistFound: [name: string, trackCount: number];
  playlistNotFound: [name: string];
  cleared: [name: string, trackCount: number];
};

// ── Service ─────────────────────────────────────────────────────────────────

export class PlaylistClearerService {
  private ctx: SpotifyContext;
  private emitter: ServiceEmitter<PlaylistClearerEventMap>;

  constructor(
    ctx: SpotifyContext,
    events?: EventHandlers<PlaylistClearerEventMap>,
  ) {
    this.ctx = ctx;
    this.emitter = new ServiceEmitter(events);
  }

  async clear(playlistName: string): Promise<{ cleared: number }> {
    // Find playlist
    const playlists: Array<{ id: string; name: string; trackCount: number }> =
      [];
    let offset = 0;

    while (true) {
      const result = await this.ctx.call(
        () => this.ctx.api.currentUser.playlists.playlists(50, offset),
        'user playlists',
      );
      if (!result.success) break;

      for (const p of result.data.items) {
        playlists.push({
          id: p.id,
          name: p.name,
          trackCount: p.tracks?.total ?? 0,
        });
      }
      if (result.data.items.length < 50) break;
      offset += 50;
    }

    const target = playlists.find((p) => p.name === playlistName);
    if (!target) {
      this.emitter.emit('playlistNotFound', playlistName);
      return { cleared: 0 };
    }

    this.emitter.emit('playlistFound', target.name, target.trackCount);

    // Get all track URIs
    const uris: Array<{ uri: string }> = [];
    let to = 0;

    while (true) {
      const result = await this.ctx.call(
        () =>
          this.ctx.api.playlists.getPlaylistItems(
            target.id,
            undefined,
            undefined,
            50,
            to,
          ),
        `playlist items ${target.id}`,
      );
      if (!result.success) break;

      for (const item of result.data.items) {
        if (item.track) {
          uris.push({ uri: `spotify:track:${item.track.id}` });
        }
      }
      if (result.data.items.length < 50) break;
      to += 50;
    }

    // Remove in batches via SDK (through ctx.call for proper retry/abort handling)
    for (let i = 0; i < uris.length; i += 100) {
      const batch = uris.slice(i, i + 100);
      await this.ctx.call(
        () =>
          this.ctx.api.playlists.removeItemsFromPlaylist(target.id, {
            tracks: batch,
          }),
        `remove tracks from ${target.name}`,
      );
    }

    this.emitter.emit('cleared', playlistName, uris.length);
    return { cleared: uris.length };
  }
}
