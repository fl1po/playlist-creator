import type { SpotifyApi } from "@spotify/web-api-ts-sdk";
import { createApiCall } from "../lib/api-wrapper.js";
import type { SpotifyClient } from "../lib/types.js";

// ── Events ──────────────────────────────────────────────────────────────────

export interface PlaylistClearerEvents {
  onPlaylistFound?: (name: string, trackCount: number) => void;
  onPlaylistNotFound?: (name: string) => void;
  onCleared?: (name: string, trackCount: number) => void;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class PlaylistClearerService {
  private client: SpotifyClient;
  private events: PlaylistClearerEvents;
  private apiCall: ReturnType<typeof createApiCall>;

  constructor(client: SpotifyClient, events?: PlaylistClearerEvents) {
    this.client = client;
    this.events = events ?? {};
    this.apiCall = createApiCall(client);
  }

  get api(): SpotifyApi {
    return this.client.api;
  }

  async clear(playlistName: string): Promise<{ cleared: number }> {
    // Find playlist
    const playlists: Array<{ id: string; name: string; trackCount: number }> = [];
    let offset = 0;

    while (true) {
      const result = await this.apiCall(
        () => this.api.currentUser.playlists.playlists(50, offset),
        "user playlists",
      );
      if (!result.success) break;

      for (const p of result.data.items) {
        playlists.push({ id: p.id, name: p.name, trackCount: p.tracks?.total ?? 0 });
      }
      if (result.data.items.length < 50) break;
      offset += 50;
    }

    const target = playlists.find((p) => p.name === playlistName);
    if (!target) {
      this.events.onPlaylistNotFound?.(playlistName);
      return { cleared: 0 };
    }

    this.events.onPlaylistFound?.(target.name, target.trackCount);

    // Get all track URIs
    const uris: Array<{ uri: string }> = [];
    let to = 0;

    while (true) {
      const result = await this.apiCall(
        () =>
          this.api.playlists.getPlaylistItems(
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
      await new Promise((r) => setTimeout(r, 50));
    }

    // Remove in batches (raw fetch to match original script behavior)
    const token = await this.client.refreshToken();
    for (let i = 0; i < uris.length; i += 100) {
      const batch = uris.slice(i, i + 100);
      await fetch(
        `https://api.spotify.com/v1/playlists/${target.id}/tracks`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tracks: batch }),
        },
      );
      await new Promise((r) => setTimeout(r, 200));
    }

    this.events.onCleared?.(playlistName, uris.length);
    return { cleared: uris.length };
  }
}
