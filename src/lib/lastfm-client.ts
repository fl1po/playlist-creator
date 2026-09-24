/**
 * Minimal Last.fm API client for album-level acclaim lookups.
 *
 * Supplies the critic signal of the acclaim blend: unlike Spotify
 * popularity, Last.fm playcount is cumulative all-time rather than weighted
 * toward recent streams, and its userbase skews album-oriented.
 *
 * Coverage is very uneven by scene — see `MIN_LASTFM_LISTENERS` in
 * services/year-collection/acclaim.ts. This
 * client reports what it finds and leaves the sample-size judgement to callers.
 */

const BASE_URL = 'https://ws.audioscrobbler.com/2.0/';
const MIN_INTERVAL_MS = 200; // 5 req/sec — well inside Last.fm's limits

/** Last.fm error 6 = "no such album", which is a miss rather than a failure. */
const NOT_FOUND = 6;

export interface LastfmAlbumInfo {
  /** Distinct users who have scrobbled the album. */
  listeners: number;
  /** Total scrobbles, all-time. */
  playcount: number;
  /** Canonical names as Last.fm resolved them — useful for match auditing. */
  matchedArtist: string;
  matchedAlbum: string;
}

export class LastfmClient {
  private lastRequestTime = 0;
  private mutex: Promise<void> = Promise.resolve();

  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error(
        'LASTFM_API_KEY is not set — required for year-collection acclaim scoring',
      );
    }
  }

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

  private async call<T>(
    params: Record<string, string>,
    retries = 3,
  ): Promise<T | null> {
    await this.pace();

    const query = new URLSearchParams({
      ...params,
      api_key: this.apiKey,
      format: 'json',
    });

    for (let attempt = 0; attempt <= retries; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}?${query}`);
      } catch {
        if (attempt === retries) return null;
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt === retries) return null;
        await new Promise((r) =>
          setTimeout(r, Math.min(2 ** attempt * 1000, 10_000)),
        );
        continue;
      }

      if (!res.ok) return null;

      const data = (await res.json()) as T & { error?: number };
      // API-level errors (e.g. NOT_FOUND for a missing album) are answers, not
      // transport failures — don't retry them.
      if (data.error) return null;
      return data;
    }
    return null;
  }

  /**
   * Look up listener and playcount figures for one album.
   * Returns null when Last.fm has no record of it, or the request still
   * fails after retries.
   */
  async albumInfo(
    artist: string,
    album: string,
  ): Promise<LastfmAlbumInfo | null> {
    const data = await this.call<{
      album?: {
        artist: string;
        name: string;
        listeners?: string;
        playcount?: string;
      };
    }>({ method: 'album.getinfo', artist, album, autocorrect: '1' });

    if (!data?.album) return null;

    const listeners = Number(data.album.listeners ?? 0);
    const playcount = Number(data.album.playcount ?? 0);
    if (!(Number.isFinite(listeners) && Number.isFinite(playcount))) {
      return null;
    }

    return {
      listeners,
      playcount,
      matchedArtist: data.album.artist,
      matchedAlbum: data.album.name,
    };
  }
}

/** Read the API key from the environment. Throws with a usable message. */
export function lastfmKeyFromEnv(): string {
  const key = process.env.LASTFM_API_KEY;
  if (!key) {
    throw new Error(
      'LASTFM_API_KEY is not set. Register a free key at ' +
        'https://www.last.fm/api/account/create and add it to .env',
    );
  }
  return key;
}

export { NOT_FOUND as LASTFM_NOT_FOUND };
