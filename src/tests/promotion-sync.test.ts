import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlaylistTrackWithArtists } from '../lib/pagination.js';
import type {
  AlbumTrack,
  ArtistData,
  TrustedArtistsFile,
} from '../lib/types.js';
import {
  type PlaylistWrites,
  type PriorityChange,
  type PromotionReads,
  type PromotionSyncInput,
  type PromotionSyncPorts,
  type SyncDecision,
  syncPriorityChanges,
} from '../services/promotion-sync/index.js';
import { fixedPopularitySource } from '../services/week-collection/adapters.js';

// ── Fixture catalog ──────────────────────────────────────────────────────────

interface FixtureAlbum {
  id: string;
  name: string;
  type: string;
  release_date: string;
  markets?: number;
  explicit?: boolean;
  tracks: AlbumTrack[];
}

interface FixtureArtist {
  id: string;
  name: string;
  albums: FixtureAlbum[];
}

interface FixturePlaylistTrack {
  id: string;
  name: string;
  artistNames: string[];
  albumId?: string;
}

interface FixturePlaylist {
  id: string;
  name: string;
  tracks: FixturePlaylistTrack[];
}

interface Catalog {
  artists: FixtureArtist[];
  playlists?: FixturePlaylist[];
}

function fixtureReads(catalog: Catalog): PromotionReads {
  const findAlbum = (albumId: string) => {
    for (const artist of catalog.artists) {
      const album = artist.albums.find((a) => a.id === albumId);
      if (album) return { artist, album };
    }
    return null;
  };
  const playlist = (id: string) =>
    catalog.playlists?.find((p) => p.id === id) ?? null;

  return {
    async searchArtist(name) {
      const artist = catalog.artists.find(
        (a) => a.name.toLowerCase() === name.toLowerCase(),
      );
      return artist ? { id: artist.id, name: artist.name } : null;
    },
    async artistAlbums(artistId) {
      const artist = catalog.artists.find((a) => a.id === artistId);
      return (artist?.albums ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        release_date: a.release_date,
        markets: a.markets ?? 0,
      }));
    },
    async albumDetails(albumId) {
      const hit = findAlbum(albumId);
      if (!hit) return null;
      return {
        id: hit.album.id,
        name: hit.album.name,
        type: hit.album.type,
        release_date: hit.album.release_date,
        explicit: hit.album.explicit ?? false,
        markets: hit.album.markets ?? 0,
        artists: [{ id: hit.artist.id, name: hit.artist.name }],
      };
    },
    async albumTracks(albumId) {
      return findAlbum(albumId)?.album.tracks ?? [];
    },
    async playlistAlbums() {
      return new Map();
    },
    async userPlaylists() {
      return [];
    },
    async artistProfile() {
      return null;
    },
    async playlistTracksWithArtists(playlistId) {
      const pl = playlist(playlistId);
      return (pl?.tracks ?? []).map(
        (t): PlaylistTrackWithArtists => ({
          uri: `spotify:track:${t.id}`,
          id: t.id,
          name: t.name,
          artistNames: t.artistNames,
          albumId: t.albumId ?? '',
        }),
      );
    },
    async playlistTrackIds(playlistId) {
      return (playlist(playlistId)?.tracks ?? []).map((t) => t.id);
    },
  };
}

interface RecordingWrites extends PlaylistWrites {
  added: Map<string, string[]>;
  removed: Map<string, string[]>;
}

function recordingWrites(): RecordingWrites {
  const added = new Map<string, string[]>();
  const removed = new Map<string, string[]>();
  return {
    added,
    removed,
    async addTracks(playlistId, trackIds) {
      added.set(playlistId, [...(added.get(playlistId) ?? []), ...trackIds]);
    },
    async removeTracks(playlistId, trackIds) {
      removed.set(playlistId, [
        ...(removed.get(playlistId) ?? []),
        ...trackIds,
      ]);
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const WEEK = '05.06.26'; // window: 2026-05-30 … 2026-06-05
const IN_WINDOW = '2026-06-05';
const OUT_OF_WINDOW = '2024-01-01';

/** Full ArtistData; tests only read priority/score/spotifyId. */
function ac(
  priority: number | null,
  score: number,
  spotifyId: string | null = null,
): ArtistData {
  return {
    allWeekly: 0,
    bestOfAllWeekly: 0,
    latestPositionAW: 0,
    latestPositionBoAW: 0,
    recencyBonusAW: 0,
    recencyBonusBoAW: 0,
    score,
    priority,
    spotifyId,
  };
}

function trusted(artistCounts: Record<string, ArtistData>): TrustedArtistsFile {
  return { artistCounts } as unknown as TrustedArtistsFile;
}

function input(
  overrides: Partial<PromotionSyncInput> = {},
): PromotionSyncInput {
  return {
    unprocessedPlaylists: [],
    awTrackIds: new Set(),
    trustedArtists: trusted({}),
    minPopularity: 30,
    ...overrides,
  };
}

function ports(
  reads: PromotionReads,
  writes: PlaylistWrites,
  scores: Record<string, number> = {},
): PromotionSyncPorts {
  return { reads, popularity: fixedPopularitySource(scores), writes };
}

const playlistList = (catalog: Catalog) =>
  (catalog.playlists ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    trackCount: p.tracks.length,
  }));

function kinds(decisions: SyncDecision[]): string[] {
  return decisions.map((d) => d.kind);
}

// ── Removal phase ────────────────────────────────────────────────────────────

test('removal: a demoted artist album is removed, a P1/P2-featured album stays', async () => {
  const catalog: Catalog = {
    artists: [],
    playlists: [
      {
        id: 'pl1',
        name: WEEK,
        tracks: [
          // Album A — only the demoted artist: removed whole.
          { id: 'a1', name: 'A1', artistNames: ['Alpha'], albumId: 'albA' },
          { id: 'a2', name: 'A2', artistNames: ['Alpha'], albumId: 'albA' },
          // Album B — demoted Alpha but features P1/P2 Beta: kept whole.
          {
            id: 'b1',
            name: 'B1',
            artistNames: ['Alpha', 'Beta'],
            albumId: 'albB',
          },
          // Album G — unrelated artist: untouched.
          { id: 'g1', name: 'G1', artistNames: ['Gamma'], albumId: 'albG' },
        ],
      },
    ],
  };
  const reads = fixtureReads(catalog);
  const writes = recordingWrites();

  const changes: PriorityChange[] = [{ artist: 'Alpha', from: 1, to: null }];
  const result = await syncPriorityChanges(
    changes,
    input({
      unprocessedPlaylists: playlistList(catalog),
      // Beta is still P1/P2; Alpha is gone.
      trustedArtists: trusted({ Beta: ac(1, 100, 'art-beta') }),
    }),
    ports(reads, writes),
  );

  assert.deepEqual(writes.removed.get('pl1'), ['a1', 'a2']);
  assert.equal(writes.added.size, 0);
  assert.equal(result.removed, 2);
  assert.equal(result.added, 0);
  // Album B recorded as kept, Album A as removed.
  assert.deepEqual(kinds(result.decisions), [
    'demotion-kept',
    'demotion-removed',
  ]);
  const removed = result.decisions.find((d) => d.kind === 'demotion-removed');
  assert.deepEqual(removed, {
    kind: 'demotion-removed',
    playlist: WEEK,
    artists: ['Alpha'],
    trackCount: 2,
  });
});

// ── Addition phase ───────────────────────────────────────────────────────────

test('addition: backfills the in-window release, excluding AW and existing tracks', async () => {
  const catalog: Catalog = {
    artists: [
      {
        id: 'art-d',
        name: 'Delta',
        albums: [
          {
            id: 'alb-x',
            name: 'X',
            type: 'album',
            release_date: IN_WINDOW,
            tracks: [
              { id: 't1', name: 'One', key: 'delta::one' },
              { id: 't2', name: 'Two', key: 'delta::two' },
              { id: 't3', name: 'Three', key: 'delta::three' },
            ],
          },
          {
            id: 'alb-old',
            name: 'Old',
            type: 'album',
            release_date: OUT_OF_WINDOW,
            tracks: [{ id: 'o1', name: 'Oldie', key: 'delta::oldie' }],
          },
        ],
      },
    ],
    // t2 already lives in the playlist; t3 is in All Weekly — both excluded.
    playlists: [
      {
        id: 'pl1',
        name: WEEK,
        tracks: [{ id: 't2', name: 'Two', artistNames: ['Delta'] }],
      },
    ],
  };
  const reads = fixtureReads(catalog);
  const writes = recordingWrites();

  const result = await syncPriorityChanges(
    [{ artist: 'Delta', from: null, to: 1 }],
    input({
      unprocessedPlaylists: playlistList(catalog),
      awTrackIds: new Set(['t3']),
      trustedArtists: trusted({ Delta: ac(1, 100, 'art-d') }),
    }),
    ports(reads, writes, { 'alb-x': 70 }),
  );

  assert.deepEqual(writes.added.get('pl1'), ['t1']); // out-of-window, t2, t3 all excluded
  assert.equal(writes.removed.size, 0);
  assert.equal(result.added, 1);
  assert.ok(result.decisions.some((d) => d.kind === 'release-found'));
});

test('addition: the lenient minPopularity bar decides whether a release survives', async () => {
  const make = (): Catalog => ({
    artists: [
      {
        id: 'art-d',
        name: 'Delta',
        albums: [
          {
            id: 'alb-mid',
            name: 'Midpop',
            type: 'album',
            release_date: IN_WINDOW,
            tracks: [{ id: 'm1', name: 'Mid', key: 'delta::mid' }],
          },
        ],
      },
    ],
    playlists: [{ id: 'pl1', name: WEEK, tracks: [] }],
  });

  const run = async (minPopularity: number) => {
    const catalog = make();
    const writes = recordingWrites();
    const result = await syncPriorityChanges(
      [{ artist: 'Delta', from: null, to: 1 }],
      input({
        unprocessedPlaylists: playlistList(catalog),
        trustedArtists: trusted({ Delta: ac(1, 100, 'art-d') }),
        minPopularity,
      }),
      ports(fixtureReads(catalog), writes, { 'alb-mid': 40 }),
    );
    return { result, writes };
  };

  const gated = await run(60); // 40 < 60 → gated out
  assert.equal(gated.writes.added.size, 0);
  assert.ok(gated.result.decisions.some((d) => d.kind === 'low-popularity'));

  const kept = await run(30); // 40 ≥ 30 → kept
  assert.deepEqual(kept.writes.added.get('pl1'), ['m1']);
});

test('addition: variant grouping is window-first — the explicit in-window twin wins, the out-of-window twin is ignored', async () => {
  const catalog: Catalog = {
    artists: [
      {
        id: 'art-v',
        name: 'Vera',
        albums: [
          {
            id: 'v-in-explicit',
            name: 'Doppel',
            type: 'album',
            release_date: IN_WINDOW,
            markets: 3,
            explicit: true,
            tracks: [{ id: 've', name: 'Cut', key: 'vera::cut' }],
          },
          {
            id: 'v-in-clean',
            name: 'Doppel',
            type: 'album',
            release_date: IN_WINDOW,
            markets: 5,
            explicit: false,
            tracks: [{ id: 'vc', name: 'Cut', key: 'vera::cut' }],
          },
          // Out-of-window twin: widest markets + explicit. Catalogue-wide
          // grouping (the old bug) would pick it, then date-drop it → nothing
          // added. Window-first never lets it into the group.
          {
            id: 'v-out',
            name: 'Doppel',
            type: 'album',
            release_date: OUT_OF_WINDOW,
            markets: 9,
            explicit: true,
            tracks: [{ id: 'vo', name: 'Cut', key: 'vera::cut' }],
          },
        ],
      },
    ],
    playlists: [{ id: 'pl1', name: WEEK, tracks: [] }],
  };
  const reads = fixtureReads(catalog);
  const writes = recordingWrites();

  const result = await syncPriorityChanges(
    [{ artist: 'Vera', from: null, to: 1 }],
    input({
      unprocessedPlaylists: playlistList(catalog),
      trustedArtists: trusted({ Vera: ac(1, 100, 'art-v') }),
    }),
    ports(reads, writes, { 'v-in-explicit': 70 }),
  );

  assert.deepEqual(writes.added.get('pl1'), ['ve']); // explicit in-window twin
  const pick = result.decisions.find((d) => d.kind === 'variant-picked');
  assert.deepEqual(pick, {
    kind: 'variant-picked',
    release: 'Doppel',
    variantCount: 2,
    explicit: true,
  });
});

test('no P1/P2 boundary crossings: nothing is read or written', async () => {
  const catalog: Catalog = {
    artists: [],
    playlists: [{ id: 'pl1', name: WEEK, tracks: [] }],
  };
  const writes = recordingWrites();
  const result = await syncPriorityChanges(
    [{ artist: 'Within', from: 3, to: 4 }], // both outside P1/P2
    input({ unprocessedPlaylists: playlistList(catalog) }),
    ports(fixtureReads(catalog), writes),
  );
  assert.equal(result.added, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.playlistsSynced, 0);
  assert.equal(writes.added.size, 0);
  assert.equal(writes.removed.size, 0);
});
