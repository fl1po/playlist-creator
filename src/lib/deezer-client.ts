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

export interface DeezerArtist {
  id: number;
  name: string;
  nb_fan: number;
}

export interface DeezerAlbumDetail {
  id: number;
  title: string;
  /** Barcode; matches Spotify's `external_ids.upc` for the same release. */
  upc?: string;
  fans: number;
  release_date: string;
  record_type: string;
  explicit_lyrics: boolean;
  tracks: { data: DeezerTrack[] };
}

/**
 * Fold a name for comparison: NFD-decompose, strip diacritics, lowercase.
 *
 * Deezer and Spotify disagree on Unicode normalization, so a raw comparison
 * drops real artists — "Sinéad Harnett", "Lila Iké", "Chlöe", "thủy" and
 * "Lolo Zouaï" all failed to resolve before this.
 */
function foldName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

export class DeezerClient {
  private lastRequestTime = 0;
  private mutex: Promise<void> = Promise.resolve();

  /** Pace requests, serializing concurrent callers. */
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
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.pace();
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

  /**
   * `fetch` that also turns an unreachable Deezer into null, for lookups
   * whose callers must tell a failure apart from a genuine empty result.
   */
  private async tryFetch<T>(path: string): Promise<T | null> {
    try {
      return await this.fetch<T>(path);
    } catch {
      return null;
    }
  }

  /** Search for an album by artist + title. Returns top 3 results. */
  async searchAlbum(query: string): Promise<DeezerAlbumSearchResult[]> {
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

  /**
   * Resolve an artist name to a Deezer artist.
   *
   * Requires an exact (case- and diacritic-insensitive) name match on one of
   * the top hits — Deezer's search happily returns tribute acts and
   * soundalikes, and a wrong resolution silently poisons the whole
   * related-artist graph downstream.
   *
   * Returns `'not-found'` when Deezer has no such artist and null when the
   * lookup failed, so a failure is never mistaken for (or cached as) one.
   */
  async searchArtist(name: string): Promise<DeezerArtist | 'not-found' | null> {
    const data = await this.tryFetch<{ data?: DeezerArtist[] }>(
      `/search/artist?q=${encodeURIComponent(name)}&limit=10`,
    );
    if (!data?.data) return null;
    const target = foldName(name);
    const matches = data.data.filter((a) => foldName(a.name) === target);
    if (matches.length === 0) return 'not-found';

    // Deezer carries duplicate and impostor profiles under the same name —
    // "Fousheé" matched a profile with 4 fans, "Chlöe" one with 7. The
    // canonical artist is the one people actually follow.
    return matches.reduce((best, a) => (a.nb_fan > best.nb_fan ? a : best));
  }

  /**
   * Artists Deezer considers similar. This is the taste graph the whole
   * expansion rests on, since Spotify's related-artists endpoint has been
   * deprecated and returns 404 for apps registered after November 2024.
   *
   * Returns null when the lookup failed and an empty list only when Deezer
   * genuinely has no related artists.
   */
  async relatedArtists(artistId: number): Promise<DeezerArtist[] | null> {
    const data = await this.tryFetch<{ data?: DeezerArtist[] }>(
      `/artist/${artistId}/related?limit=25`,
    );
    return data?.data ?? null;
  }
}
