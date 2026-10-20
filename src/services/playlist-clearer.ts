import type { ApiResult } from '../lib/spotify/gateway.js';
import { type LogLine, line } from '../lib/task-log.js';
import type { UserSession } from '../lib/user-session.js';
import { forgetAiPicks } from './ai-picks.js';

export type ClearEvent =
  | { kind: 'found'; name: string; trackCount: number }
  | { kind: 'not-found'; name: string }
  | { kind: 'cleared'; name: string; trackCount: number };

/** A clear's task-log lines (ADR-0007). */
export function describeClear(e: ClearEvent): LogLine[] {
  switch (e.kind) {
    case 'found':
      return [line(`Found "${e.name}" (${e.trackCount} tracks)`)];
    case 'not-found':
      return [line(`Playlist "${e.name}" not found`, 'warn')];
    case 'cleared':
      return [
        line(`Cleared ${e.trackCount} tracks from "${e.name}"`, 'success'),
      ];
  }
}

export class PlaylistClearerService {
  constructor(
    private session: UserSession,
    private onEvent: (e: ClearEvent) => void = () => {},
  ) {}

  /**
   * Removes every track from the user's playlist named `playlistName`.
   * Throws if any read or removal fails rather than reporting a partial clear;
   * the error says how many tracks were already removed.
   *
   * A cleared weekly playlist is an unfilled Friday again, so its AI picks
   * are forgotten with it. Picks are kept by weekly playlist name, so any
   * other playlist has none to forget.
   */
  async clear(playlistName: string): Promise<{ cleared: number }> {
    const playlists: Array<{ id: string; name: string; trackCount: number }> =
      [];
    let offset = 0;

    while (true) {
      const result = await this.session.gateway.call(
        (api) => api.currentUser.playlists.playlists(50, offset),
        'user playlists',
      );
      if (!result.success) throw failure('list playlists', result);

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
      this.onEvent({ kind: 'not-found', name: playlistName });
      return { cleared: 0 };
    }

    this.onEvent({
      kind: 'found',
      name: target.name,
      trackCount: target.trackCount,
    });

    const uris: Array<{ uri: string }> = [];
    let itemOffset = 0;

    while (true) {
      const result = await this.session.gateway.call(
        (api) =>
          api.playlists.getPlaylistItems(
            target.id,
            undefined,
            undefined,
            50,
            itemOffset,
          ),
        `playlist items ${target.id}`,
      );
      if (!result.success) {
        throw failure(`read tracks of "${target.name}"`, result);
      }

      for (const item of result.data.items) {
        // The item's own URI also covers episodes and local files, which
        // have no usable track id.
        if (item.track?.uri) uris.push({ uri: item.track.uri });
      }
      if (result.data.items.length < 50) break;
      itemOffset += 50;
    }

    // Spotify caps removals at 100 items per request; going through the gateway's call
    // (not the raw SDK) keeps retry/abort handling.
    for (let i = 0; i < uris.length; i += 100) {
      const batch = uris.slice(i, i + 100);
      const result = await this.session.gateway.call(
        (api) =>
          api.playlists.removeItemsFromPlaylist(target.id, {
            tracks: batch,
          }),
        `remove tracks from ${target.name}`,
      );
      if (!result.success) {
        throw failure(
          `remove tracks from "${target.name}" (${i} of ${uris.length} removed)`,
          result,
        );
      }
    }

    await forgetAiPicks(this.session.data, target.name);

    this.onEvent({
      kind: 'cleared',
      name: playlistName,
      trackCount: uris.length,
    });
    return { cleared: uris.length };
  }
}

function failure(action: string, result: ApiResult<unknown>): Error {
  const reason =
    !result.success && result.error ? `: ${result.error.message}` : '';
  return new Error(`Failed to ${action}${reason}`);
}
