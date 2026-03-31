import { type EventHandlers, ServiceEmitter } from '../lib/service-events.js';
import type { SpotifyContext } from '../lib/spotify-context.js';
import type { ArtistData, TrustedArtistsFile } from '../lib/types.js';

// ── Events ──────────────────────────────────────────────────────────────────

export type ArtistLookupEventMap = {
  result: [result: ArtistLookupResult];
  notFound: [query: string];
};

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
  private ctx: SpotifyContext;
  private emitter: ServiceEmitter<ArtistLookupEventMap>;

  constructor(
    ctx: SpotifyContext,
    events?: EventHandlers<ArtistLookupEventMap>,
  ) {
    this.ctx = ctx;
    this.emitter = new ServiceEmitter(events);
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
      this.emitter.emit('notFound', query);
      return [];
    }

    // Pre-compute rankings per priority group
    const rankByPriority: Record<
      number,
      Array<{ name: string; score: number }>
    > = {};
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
        const spotifyId = data.spotifyId;
        const result = await this.ctx.call(
          () => this.ctx.api.artists.get(spotifyId),
          `artist ${spotifyId}`,
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
      this.emitter.emit('result', r);
    }

    return results;
  }
}
