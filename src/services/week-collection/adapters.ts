import { fetchDeezerPopularities } from '../../lib/deezer-popularity.js';
import type {
  Candidate,
  CandidateRequest,
  CandidateSource,
  CheckpointStore,
  PopularitySource,
  TasteJudge,
  TasteJudgeOutcome,
  TasteJudgeRequest,
  WeekProgress,
} from './index.js';

/** Production PopularitySource: Deezer track ranks normalized to 0–100. */
export function deezerPopularitySource(
  checkAbort?: () => void,
): PopularitySource {
  return {
    lookup(releases, onProgress) {
      return fetchDeezerPopularities(releases, { onProgress, checkAbort });
    },
  };
}

/** Fixed-map PopularitySource for tests. Omitted ids count as unknown. */
export function fixedPopularitySource(
  scores: Record<string, number>,
): PopularitySource {
  return {
    async lookup() {
      return new Map(Object.entries(scores));
    },
  };
}

/** In-memory CheckpointStore for tests and one-off runs. */
export function memoryCheckpoints(): CheckpointStore & {
  current: WeekProgress | null;
} {
  return {
    current: null,
    async load(week) {
      return this.current?.week === week ? this.current : null;
    },
    async save(progress) {
      this.current = progress;
    },
    async clear() {
      this.current = null;
    },
  };
}

/**
 * Fixed-list CandidateSource for tests. Records each request it's given.
 * Like the Deezer adapter, it hands back each reject it's given as a
 * candidate (`reject-<albumId>`) with its gate provenance and album id, and
 * each scouting album as one Spotify-only candidate (`scout-<albumId>`)
 * listing every playlist it's in, as when Deezer has no match.
 */
export function fixtureCandidates(
  candidates: Candidate[],
): CandidateSource & { requests: CandidateRequest[] } {
  return {
    requests: [],
    async candidates(request) {
      this.requests.push(request);
      return [
        ...candidates,
        ...request.rejects.map(
          (r): Candidate => ({
            id: `reject-${r.albumId}`,
            title: r.title,
            artist: r.artist,
            type: r.type,
            trackCount: 1,
            releaseDate: r.releaseDate,
            genres: [],
            artistFans: null,
            upc: null,
            relativePopularity: null,
            provenance: [r.provenance],
            spotifyAlbumId: r.albumId,
          }),
        ),
        ...request.scouting
          .filter(
            (s, i, all) =>
              all.findIndex((o) => o.album.id === s.album.id) === i,
          )
          .map(
            ({ album }): Candidate => ({
              id: `scout-${album.id}`,
              title: album.name,
              artist: album.artistName,
              type: album.albumType,
              trackCount: album.totalTracks,
              releaseDate: album.releaseDate,
              genres: [],
              artistFans: null,
              upc: null,
              relativePopularity: null,
              provenance: request.scouting
                .filter((s) => s.album.id === album.id)
                .map((s) => ({ kind: 'scouting', playlist: s.playlist })),
              spotifyAlbumId: album.id,
            }),
          ),
      ];
    },
  };
}

/**
 * Scripted TasteJudge for tests: returns `outcome` (or what it computes from
 * the request) and records each request, so tests can check the pool and
 * taste context it was given.
 */
export function fixtureJudge(
  outcome: TasteJudgeOutcome | ((r: TasteJudgeRequest) => TasteJudgeOutcome),
): TasteJudge & { requests: TasteJudgeRequest[] } {
  return {
    requests: [],
    async judge(request) {
      this.requests.push(request);
      return typeof outcome === 'function' ? outcome(request) : outcome;
    },
  };
}
