import type { SpotifyApi } from "@spotify/web-api-ts-sdk";
import { createApiCall } from "../lib/api-wrapper.js";
import type { ArtistData, SpotifyClient, TrustedArtistsFile } from "../lib/types.js";

// ── Events ──────────────────────────────────────────────────────────────────

export interface ArtistLookupEvents {
  onResult?: (result: ArtistLookupResult) => void;
  onNotFound?: (query: string) => void;
}

export interface ArtistLookupResult {
  name: string;
  data: ArtistData;
  popularity: number | null;
  followers: number | null;
  genres: string[];
  priorityRank: number | null;
  priorityGroupSize: number | null;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class ArtistLookupService {
  private client: SpotifyClient;
  private events: ArtistLookupEvents;
  private apiCall: ReturnType<typeof createApiCall>;

  constructor(
    client: SpotifyClient,
    events?: ArtistLookupEvents,
  ) {
    this.client = client;
    this.events = events ?? {};
    this.apiCall = createApiCall(client);
  }

  get api(): SpotifyApi {
    return this.client.api;
  }

  async lookup(
    query: string,
    trustedArtists: TrustedArtistsFile,
  ): Promise<ArtistLookupResult[]> {
    const artists = trustedArtists.artistCounts;
    const queryLower = query.toLowerCase();

    const matches = Object.entries(artists).filter(([name]) =>
      name.toLowerCase().includes(queryLower),
    );

    if (matches.length === 0) {
      this.events.onNotFound?.(query);
      return [];
    }

    // Pre-compute rankings per priority group
    const rankByPriority: Record<number, Array<{ name: string; score: number }>> = {};
    for (const [n, a] of Object.entries(artists)) {
      if (!a.priority) continue;
      if (!rankByPriority[a.priority]) rankByPriority[a.priority] = [];
      rankByPriority[a.priority].push({ name: n, score: a.score });
    }
    for (const p of Object.keys(rankByPriority)) {
      rankByPriority[Number(p)].sort((a, b) => b.score - a.score);
    }

    const results: ArtistLookupResult[] = [];

    for (const [name, data] of matches) {
      let popularity: number | null = null;
      let followers: number | null = null;
      let genres: string[] = [];

      if (data.spotifyId) {
        const result = await this.apiCall(
          () => this.api.artists.get(data.spotifyId!),
          `artist ${data.spotifyId}`,
        );
        if (result.success) {
          popularity = result.data.popularity;
          followers = result.data.followers.total;
          genres = result.data.genres;
        }
      }

      let priorityRank: number | null = null;
      let priorityGroupSize: number | null = null;
      if (data.priority && rankByPriority[data.priority]) {
        const list = rankByPriority[data.priority];
        priorityRank = list.findIndex((a) => a.name === name) + 1;
        priorityGroupSize = list.length;
      }

      const r: ArtistLookupResult = {
        name,
        data,
        popularity,
        followers,
        genres,
        priorityRank,
        priorityGroupSize,
      };
      results.push(r);
      this.events.onResult?.(r);
    }

    return results;
  }
}
