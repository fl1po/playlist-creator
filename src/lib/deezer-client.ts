/**
 * Minimal Deezer API client for catalog lookups.
 * No authentication required — public endpoints only.
 */

const BASE_URL = 'https://api.deezer.com';
const MIN_INTERVAL_MS = 100; // 10 req/sec

interface DeezerAlbumSearchResult {
  id: number;
  title: string;
  record_type: string;
  artist: { id: number; name: string };
}

interface DeezerTrack {
  id: number;
  title: string;
  rank: number;
  duration: number;
  explicit_lyrics: boolean;
}

export interface DeezerAlbumDetail {
  id: number;
  title: string;
  fans: number;
  release_date: string;
  record_type: string;
  explicit_lyrics: boolean;
  tracks: { data: DeezerTrack[] };
}

export class DeezerClient {
  private lastRequestTime = 0;
  private mutex: Promise<void> = Promise.resolve();

  /** Pace requests to stay within rate limits. */
  private async pace(): Promise<void> {
    const prev = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      const elapsed = Date.now() - this.lastRequestTime;
      const wait = MIN_INTERVAL_MS - elapsed;
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
      this.lastRequestTime = Date.now();
    } finally {
      release();
    }
  }

  private async fetch<T>(path: string, retries = 3): Promise<T | null> {
    await this.pace();

    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch(`${BASE_URL}${path}`);

      if (res.status === 429) {
        const wait = Math.min(2 ** attempt * 1000, 10_000);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) return null;

      const data = (await res.json()) as T & { error?: unknown };
      if (data.error) return null;
      return data;
    }
    return null;
  }

  /** Search for an album by artist + title. Returns top 3 results. */
  async searchAlbum(
    query: string,
  ): Promise<DeezerAlbumSearchResult[]> {
    const encoded = encodeURIComponent(query);
    const data = await this.fetch<{ data: DeezerAlbumSearchResult[] }>(
      `/search/album?q=${encoded}&limit=3`,
    );
    return data?.data ?? [];
  }

  /** Get full album details including tracks with rank. */
  async getAlbum(albumId: number): Promise<DeezerAlbumDetail | null> {
    return this.fetch<DeezerAlbumDetail>(`/album/${albumId}`);
  }
}
