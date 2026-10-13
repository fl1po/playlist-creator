import {
  type GenreFilterLists,
  hasRejectedGenre,
  isGenreAcceptable,
} from '../../domain/filters.js';
import {
  filterLowPopularity,
  filterVariants,
  releaseDateFallbackMatch,
} from '../../domain/releases.js';
import { getValidDates, parseDate } from '../../domain/tracks.js';
import type {
  AlbumTrack,
  FoundRelease,
  PlaylistAlbumInfo,
  TrustedArtistsFile,
} from '../../lib/types.js';
import { containPickFailures, landAiPicks, runAiPhase } from './ai-finds.js';
import { type Run, collectTracks, getArtistWindowReleases } from './engine.js';

// ── Ports (the seam) ─────────────────────────────────────────────────────────

export interface RawAlbum {
  id: string;
  name: string;
  type: string;
  release_date: string;
  markets: number;
}

export interface AlbumDetails {
  id: string;
  name: string;
  type: string;
  release_date: string;
  /** True when any track on the album is explicit. */
  explicit: boolean;
  markets: number;
  artists: Array<{ id: string; name: string }>;
}

/** A Spotify album found by its barcode. */
export interface BarcodeAlbum extends RawAlbum {
  artists: Array<{ id: string; name: string }>;
}

export interface ArtistProfile {
  popularity: number;
  followers: number;
  genres: string[];
}

/**
 * The Spotify reads a week collection needs. Prod adapter wraps
 * SpotifyGateway + pagination; test adapter is an in-memory fixture catalog.
 *
 * Error contract: every method throws on auth failure (the caller re-auths
 * and retries the week). `searchArtist`, `searchByUpc`, `albumDetails` and
 * `artistProfile` return null on other failures so collection degrades
 * instead of aborting; `userPlaylists` returns [] and `artistAlbums` returns
 * the pages fetched before the failure. `albumTracks` and `playlistAlbums`
 * may throw on persistent failures.
 */
export interface ReleaseReads {
  searchArtist(name: string): Promise<{ id: string; name: string } | null>;
  /** One album search by barcode (`upc:`); the first hit, or null. */
  searchByUpc(upc: string): Promise<BarcodeAlbum | null>;
  /** Artist album/single/compilation pages, flattened (first 3 pages). */
  artistAlbums(artistId: string): Promise<RawAlbum[]>;
  albumDetails(albumId: string): Promise<AlbumDetails | null>;
  albumTracks(albumId: string): Promise<AlbumTrack[]>;
  playlistAlbums(playlistId: string): Promise<Map<string, PlaylistAlbumInfo>>;
  userPlaylists(userId: string): Promise<Array<{ id: string; name: string }>>;
  artistProfile(artistId: string): Promise<ArtistProfile | null>;
}

/** Release popularity lookup. Prod = Deezer; test = fixed map. */
export interface PopularitySource {
  /** Release id → 0–100 popularity. Omitted ids are treated as unknown. */
  lookup(
    releases: Map<string, FoundRelease>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<string, number>>;
}

/**
 * Week-progress persistence. The module owns checkpoint cadence (every
 * `CHECKPOINT_EVERY` searched artists, on any throw mid-search, and on
 * completing the search) and resume; the caller clears a week's checkpoint
 * once it is written. The store only decides where progress lives.
 */
export interface CheckpointStore {
  load(week: string): Promise<WeekProgress | null>;
  save(progress: WeekProgress): Promise<void>;
  clear(week: string): Promise<void>;
}

export interface WeekProgress {
  week: string;
  artistsSearched: number;
  foundReleases: Record<string, FoundRelease>;
}

// ── AI finds ports (ADR-0005) ────────────────────────────────────────────────

/** Where a candidate came from. A candidate keeps every source it came from. */
export type CandidateProvenance =
  | { kind: 'related'; to: string[] }
  | { kind: 'roster'; priority: number | null }
  | { kind: 'scouting'; playlist: string }
  | { kind: 'editorial-reject'; reason: string; playlists: string[] }
  | { kind: 'low-popularity'; popularity: number; playlists: string[] };

/** One release the judge may pick, in Deezer shape. */
export interface Candidate {
  /** Pool id the judge answers with. */
  id: string;
  title: string;
  artist: string;
  type: string;
  trackCount: number;
  /** `YYYY-MM-DD`. */
  releaseDate: string;
  genres: string[];
  artistFans: number | null;
  upc: string | null;
  /**
   * Best track rank ÷ the median rank of the artist's top 10 tracks on other
   * releases; null when unknown.
   */
  relativePopularity: number | null;
  provenance: CandidateProvenance[];
  /** Known when the candidate came from Spotify (e.g. a scouting playlist). */
  spotifyAlbumId?: string;
}

/**
 * A release the week's gates turned away, kept for a second look: an
 * editorial-gate reject (reason e.g. `popularity 6`), or an editorial find
 * the release popularity gate dropped. Never a reject-list hit.
 */
export interface CandidateReject {
  /** The Spotify album id, kept so a pick needs no search. */
  albumId: string;
  artist: string;
  title: string;
  type: string;
  releaseDate: string;
  provenance: Extract<
    CandidateProvenance,
    { kind: 'editorial-reject' | 'low-popularity' }
  >;
}

export interface CandidateRequest {
  /** The P1/P2 artists: seeds for related artists, never candidates. */
  seeds: Array<{ name: string; spotifyId: string | null }>;
  /** P3/P4 and unranked roster artists. */
  rosterArtists: Array<{
    name: string;
    priority: number | null;
    spotifyId: string | null;
  }>;
  scouting: Array<{ playlist: string; album: PlaylistAlbumInfo }>;
  rejects: CandidateReject[];
  /** The week's valid release dates, `YYYY-MM-DD`. */
  window: string[];
}

/** The candidate source's liveness, passed on as week progress. */
export type CandidateProgress =
  /** The related-artist graph top-up: seeds fetched of those to fetch. */
  | { phase: 'related-artists'; done: number; total: number }
  /** Seeds whose lookup failed this time; their related artists are missing. */
  | { phase: 'related-artists-failed'; seeds: number };

/** The week's candidates. Prod = Deezer; test = fixed list. */
export interface CandidateSource {
  candidates(
    request: CandidateRequest,
    onProgress?: (e: CandidateProgress) => void,
  ): Promise<Candidate[]>;
}

export type Tier = 'P1' | 'P2' | 'P3' | 'P4' | 'unranked';

/** What the judge weighs candidates against. Names and tiers, no scores. */
export interface TasteContext {
  roster: Array<{ name: string; tier: Tier }>;
  /** The week's P1/P2 releases: what the user is already getting. */
  weekReleases: Array<{ artist: string; release: string }>;
  /** Accepted genres, as a soft preference. */
  acceptGenres: string[];
}

export interface TasteJudgeRequest {
  taste: TasteContext;
  candidates: Candidate[];
  /** What's left of the fill's AI spend ceiling, in USD. */
  budgetUsd: number;
}

export interface JudgePick {
  /** A candidate id from the request. */
  id: string;
  /** 0–100. */
  confidence: number;
  reason: string;
}

/** SDK-free: no Anthropic types or errors cross this seam. */
export type TasteJudgeOutcome =
  | { ok: true; picks: JudgePick[]; spendUsd: number }
  | {
      ok: false;
      failure: 'no-api-key' | 'over-budget' | 'spend-cap';
      spendUsd: number;
    }
  | { ok: false; failure: 'failed'; message: string; spendUsd: number };

/** Picks candidates that fit the user's taste. Prod = Claude; test = script. */
export interface TasteJudge {
  judge(request: TasteJudgeRequest): Promise<TasteJudgeOutcome>;
}

export interface WeekCollectionPorts {
  reads: ReleaseReads;
  popularity: PopularitySource;
  checkpoints: CheckpointStore;
  /** AI finds only. Without both, the AI phase doesn't run. */
  candidates?: CandidateSource;
  judge?: TasteJudge;
}

// ── Collection decisions (the audit trail, returned as data) ────────────────

export type VariantStripReason =
  | 'instrumental'
  | 'clean'
  | 'acoustic'
  | 'sped up'
  | 'slowed'
  | 'all-instrumental';

export type CollectionDecision =
  | {
      kind: 'release-found';
      artist: string;
      release: string;
      type: string;
      source?: string;
    }
  | {
      kind: 'variant-picked';
      release: string;
      variantCount: number;
      explicit: boolean;
    }
  | {
      kind: 'variant-stripped';
      reason: VariantStripReason;
      artist: string;
      release: string;
    }
  | {
      kind: 'low-popularity';
      artist: string;
      release: string;
      albumId: string;
      popularity: number;
    }
  | {
      kind: 'deluxe-stripped';
      release: string;
      baseName: string;
      originalTrackCount: number;
      bonusTracks: number;
    }
  | {
      kind: 'title-track-only';
      release: string;
      track: string;
      oldTracks: number;
      otherTracks: number;
    }
  | { kind: 'single-skipped'; release: string }
  | {
      kind: 'ai-pick';
      artist: string;
      release: string;
      albumId: string;
      confidence: number;
      reason: string;
    }
  | {
      kind: 'ai-skipped';
      reason: AiSkipReason;
      /** Set on per-pick skips. */
      artist?: string;
      release?: string;
    };

/** Why the week's AI finds, or one pick, didn't land. */
export type AiSkipReason =
  | 'no-api-key'
  | 'over-budget'
  | 'failed'
  | 'not on Spotify'
  | 'no tracks left';

// ── Progress (liveness only — never carries decisions) ──────────────────────

export type WeekProgressEvent =
  | { phase: 'resumed'; searched: number; total: number; found: number }
  | { phase: 'searching'; searched: number; total: number; artist: string }
  | {
      phase: 'release-found';
      artist: string;
      release: string;
      type: string;
      source?: string;
    }
  | { phase: 'checkpoint'; searched: number; total: number }
  | { phase: 'editorial'; playlist: string }
  | { phase: 'popularity'; done: number; total: number }
  | { phase: 'collecting'; done: number; total: number; release: string }
  | {
      phase: 'ai-pick';
      artist: string;
      release: string;
      confidence: number;
      reason: string;
    }
  | {
      phase: 'ai-skip';
      reason: AiSkipReason;
      artist?: string;
      release?: string;
      /** A failed judge call's message: for the log, never stored. */
      message?: string;
    }
  | CandidateProgress
  | {
      phase: 'ai-summary';
      picks: number;
      candidates: number;
      spendUsd: number;
    };

// ── Input / result ───────────────────────────────────────────────────────────

export interface EditorialConfig {
  playlists: Array<{ id: string; name: string }>;
  externalSources: Array<{
    userId: string;
    namePattern: string;
    dateFormat: string;
    label: string;
  }>;
  gate: { minPopularity: number; minFollowers: number };
  genreFilters?: GenreFilterLists;
}

export interface WeekCollectionInput {
  /** The Friday, `DD.MM.YY`. Drives the date window and the checkpoint key. */
  week: string;
  /** P1/P2 roster to search: [artistName, { priority, score, spotifyId }]. */
  roster: Array<
    [
      string,
      { priority: number | null; score: number; spotifyId?: string | null },
    ]
  >;
  /** Full roster, to resolve editorial finds to P1/P2 or 'editorial'. */
  trustedArtists: TrustedArtistsFile;
  /** Track ids already in the listening history — excluded outright. */
  listeningHistory: Set<string>;
  editorial: EditorialConfig;
  /** AI finds. Absent or disabled: the phase doesn't run and leaves no trace. */
  ai?: AiFindsConfig;
}

export interface AiFindsConfig {
  enabled: boolean;
  /** The server has an Anthropic key. Without one the week is `no-api-key`. */
  hasApiKey: boolean;
  /** Lowest confidence (0–100) a pick needs to land. */
  threshold: number;
  scoutingPlaylists: Array<{ id: string; name: string }>;
  /**
   * What's left of the fill's AI spend ceiling, in USD. None left: the week
   * is `over-budget` without a judge call.
   */
  budgetUsd: number;
}

/** What a week's AI phase came to, for the AI-picks record. */
export type AiPicksRecord =
  | {
      picks: Array<{
        albumId: string;
        artist: string;
        title: string;
        confidence: number;
        reason: string;
      }>;
    }
  | { skipped: 'no-api-key' | 'over-budget' | 'failed' };

export interface WeekCollection {
  week: string;
  /**
   * Final play order: releases ranked by popularity, ties keeping albums
   * before singles; then AI finds, highest confidence first.
   */
  tracks: string[];
  /** Surviving releases in collection order, with contributed track counts. */
  releases: Array<FoundRelease & { tracksAdded: number }>;
  /** Complete chronological audit trail. */
  decisions: CollectionDecision[];
  /** Tracks considered but excluded by any dedup/gate rule. */
  skippedCount: number;
  /** The AI phase's outcome; absent when it didn't run. */
  aiPicks?: AiPicksRecord;
  /** What the AI phase spent in USD, failed calls included; 0 if not run. */
  aiSpendUsd: number;
  /** The judge hit the provider's spend cap: the fill should stop calling it. */
  aiExhausted: boolean;
}

const CHECKPOINT_EVERY = 50;

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Gather one Friday's week collection.
 *
 * Invariants on a normal return: no track id appears twice and none from the
 * listening history appears at all; every track traces to exactly one release;
 * each release kept exactly one variant; `decisions` records every choice
 * that altered the outcome, in the order it was made.
 *
 * AI finds (only when `input.ai` is enabled and both AI ports are given):
 * after the popularity gate, the judge picks from a pool of candidates the
 * search didn't cover, including the editorial gate's rejects and the
 * editorial finds the popularity gate dropped. Picks at or above the
 * threshold resolve to Spotify, skip the gate, and go through the same
 * variant strip and track rules.
 * Nothing about AI finds fails the week: a judge failure, no budget, or a
 * pick's failing Spotify reads become `ai-skipped` decisions, and a throwing
 * candidate source a smaller pool. Only an abort or `SpotifyAuthLost`
 * propagates.
 *
 * Error mode: any throw during the artist search phase checkpoints week
 * progress first, then propagates — a later call with the same week resumes
 * from the checkpoint. Auth errors always propagate. A per-artist search
 * failure skips that artist.
 *
 * Checkpoint lifetime: on completing the search phase the checkpoint is
 * saved as completed (`artistsSearched` = roster length), not cleared. The
 * caller clears it once the week is written; until then a later call with
 * the same week skips the search and reuses its found releases. A completed
 * checkpoint left by a week that never got written has no expiry.
 */
export async function collectWeek(
  input: WeekCollectionInput,
  ports: WeekCollectionPorts,
  onProgress?: (e: WeekProgressEvent) => void,
): Promise<WeekCollection> {
  const { week, roster, trustedArtists, listeningHistory, editorial } = input;
  const { reads, popularity, checkpoints } = ports;
  const validDates = getValidDates(parseDate(week));
  const run: Run = {
    reads,
    decisions: [],
    onProgress,
    albumsByArtist: new Map(),
  };

  // ── Search P1/P2 artists (resuming from checkpoint) ───────────────────────
  const foundReleases = new Map<string, FoundRelease>();
  let artistsSearched = 0;
  const saveProgress = () =>
    checkpoints.save({
      week,
      artistsSearched,
      foundReleases: Object.fromEntries(foundReleases),
    });
  const saved = await checkpoints.load(week);
  if (saved && saved.artistsSearched > 0) {
    artistsSearched = saved.artistsSearched;
    for (const [id, release] of Object.entries(saved.foundReleases)) {
      foundReleases.set(id, release);
    }
    onProgress?.({
      phase: 'resumed',
      searched: artistsSearched,
      total: roster.length,
      found: foundReleases.size,
    });
  }

  try {
    for (let ai = artistsSearched; ai < roster.length; ai++) {
      const [name, data] = roster[ai];
      // Anchor to the artist that actually earned the priority. A fresh name
      // search can resolve a common name (e.g. "Ebenezer") to an unrelated
      // Spotify artist and pull in their whole catalog. Fall back to search
      // only when no id was stored.
      const artist = data.spotifyId
        ? { id: data.spotifyId, name }
        : await reads.searchArtist(name);
      if (!artist) {
        artistsSearched = ai + 1;
        continue;
      }
      const releases = await getArtistWindowReleases(
        run,
        artist.id,
        validDates,
      );
      for (const release of releases) {
        if (!foundReleases.has(release.id)) {
          foundReleases.set(release.id, {
            id: release.id,
            name: release.name,
            type: release.type,
            release_date: release.release_date,
            markets: release.markets,
            artistName: name,
            artistSpotifyId: artist.id,
            priority: data.priority ?? 0,
            score: data.score,
          });
          run.decisions.push({
            kind: 'release-found',
            artist: name,
            release: release.name,
            type: release.type,
          });
          onProgress?.({
            phase: 'release-found',
            artist: name,
            release: release.name,
            type: release.type,
          });
        }
      }
      artistsSearched = ai + 1;
      onProgress?.({
        phase: 'searching',
        searched: artistsSearched,
        total: roster.length,
        artist: name,
      });
      if (artistsSearched % CHECKPOINT_EVERY === 0) {
        await saveProgress();
        onProgress?.({
          phase: 'checkpoint',
          searched: artistsSearched,
          total: roster.length,
        });
      }
    }
  } catch (e) {
    await saveProgress();
    throw e;
  }

  // The completed search outlives this call: the caller clears it once the
  // week is written, so a later stop resumes past the search.
  await saveProgress();

  // ── Editorial merge ────────────────────────────────────────────────────────
  const { rejects, playlistsOf } = await mergeEditorial(
    run,
    week,
    validDates,
    foundReleases,
    trustedArtists,
    editorial,
  );

  // ── Popularity gate + ranking ─────────────────────────────────────────────
  const releasePopularity = await popularity.lookup(
    foundReleases,
    (done, total) => onProgress?.({ phase: 'popularity', done, total }),
  );
  const lowPop = filterLowPopularity(
    foundReleases,
    releasePopularity,
    editorial.gate.minPopularity,
  );
  for (const id of lowPop) {
    const r = foundReleases.get(id);
    if (!r) continue;
    const releasePop = releasePopularity.get(id) ?? 0;
    run.decisions.push({
      kind: 'low-popularity',
      artist: r.artistName,
      release: r.name,
      albumId: id,
      popularity: releasePop,
    });
    foundReleases.delete(id);
    // An editorial find the gate dropped gets a second look from the judge.
    if (r.priority === 'editorial') {
      rejects.push({
        albumId: id,
        artist: r.artistName,
        title: r.name,
        type: r.type,
        releaseDate: r.release_date,
        provenance: {
          kind: 'low-popularity',
          popularity: releasePop,
          playlists: playlistsOf.get(id) ?? [],
        },
      });
    }
  }

  // ── AI finds (picks skip the popularity gate) ─────────────────────────────
  const aiPhase =
    input.ai?.enabled && ports.candidates && ports.judge
      ? await runAiPhase(
          run,
          input,
          input.ai,
          { candidates: ports.candidates, judge: ports.judge },
          { window: validDates, foundReleases, rejects },
        )
      : null;
  for (const { release } of aiPhase?.picks ?? []) {
    foundReleases.set(release.id, release);
  }

  // ── Variant strip (alternate versions of kept releases) ──────────────────
  const { filtered: variantIds, removed } = filterVariants(foundReleases);
  for (const { type, release } of removed) {
    run.decisions.push({
      kind: 'variant-stripped',
      reason: type as VariantStripReason,
      artist: release.artistName,
      release: release.name,
    });
  }
  for (const id of variantIds) foundReleases.delete(id);

  // ── Track collection (deluxe / title-track / history dedup) ──────────────
  const { collected, skippedCount } = await collectTracks(
    run,
    foundReleases,
    listeningHistory,
    aiPhase ? containPickFailures(aiPhase) : undefined,
  );

  const releases = collected.map((c) => ({
    ...c.release,
    tracksAdded: c.trackIds.length,
  }));
  const aiPicks = aiPhase ? landAiPicks(run, aiPhase, collected) : undefined;
  // AI finds play after the popularity-ranked releases, by confidence.
  const ranked = [
    ...collected
      .filter((c) => !c.release.aiFind)
      .sort(
        (a, b) =>
          (releasePopularity.get(b.release.id) ?? 0) -
          (releasePopularity.get(a.release.id) ?? 0),
      ),
    ...collected
      .filter((c) => c.release.aiFind)
      .sort(
        (a, b) =>
          (b.release.aiFind?.confidence ?? 0) -
          (a.release.aiFind?.confidence ?? 0),
      ),
  ];
  const tracks = ranked.flatMap((c) => c.trackIds);

  return {
    week,
    tracks,
    releases,
    decisions: run.decisions,
    skippedCount,
    aiPicks,
    aiSpendUsd: aiPhase?.spendUsd ?? 0,
    aiExhausted: aiPhase?.exhausted ?? false,
  };
}

// ── Editorial merge ──────────────────────────────────────────────────────────

function formatExternalDate(week: string, dateFormat: string): string {
  const dd = week.slice(0, 2);
  const mm = week.slice(3, 5);
  const yy = week.slice(6, 8);
  if (dateFormat === 'DD.MM.YYYY') return `${dd}.${mm}.20${yy}`;
  if (dateFormat === 'YYYY-MM-DD') return `20${yy}-${mm}-${dd}`;
  if (dateFormat === 'MM/DD/YYYY') return `${mm}/${dd}/20${yy}`;
  return `${dd}.${mm}.20${yy}`;
}

/**
 * Admit editorial finds into `foundReleases`. Returns the gate's rejects
 * (never reject-list hits), each with the playlists it appeared in, and the
 * playlists each admitted find appeared in.
 */
async function mergeEditorial(
  run: Run,
  week: string,
  validDates: string[],
  foundReleases: Map<string, FoundRelease>,
  trustedArtists: TrustedArtistsFile,
  editorial: EditorialConfig,
): Promise<{
  rejects: CandidateReject[];
  playlistsOf: Map<string, string[]>;
}> {
  const playlists = [...editorial.playlists];

  for (const source of editorial.externalSources) {
    const dateStr = formatExternalDate(week, source.dateFormat);
    const pattern = new RegExp(source.namePattern);
    const candidates = await run.reads.userPlaylists(source.userId);
    const match = candidates.find(
      (p) => p.name.includes(dateStr) && pattern.test(p.name),
    );
    if (match) playlists.unshift({ id: match.id, name: match.name });
  }

  // Artist|title keys catch the same release under a different album id
  // (regional duplicates) that the id check alone would let through.
  const releaseKeys = new Set(
    [...foundReleases.values()].map(
      (r) => `${r.artistName.toLowerCase()}|${r.name.toLowerCase().trim()}`,
    ),
  );

  // Playlists each admitted find or reject appeared in, by album id.
  const playlistsOf = new Map<string, string[]>();
  const rejects = new Map<string, CandidateReject>();

  for (const playlist of playlists) {
    run.onProgress?.({ phase: 'editorial', playlist: playlist.name });
    const albums = await run.reads.playlistAlbums(playlist.id);
    for (const [albumId, albumInfo] of albums) {
      const seenIn = playlistsOf.get(albumId);
      if (seenIn) {
        if (!seenIn.includes(playlist.name)) seenIn.push(playlist.name);
        continue;
      }
      if (foundReleases.has(albumId)) continue;
      const infoKey = `${albumInfo.artistName.toLowerCase()}|${albumInfo.name.toLowerCase().trim()}`;
      if (releaseKeys.has(infoKey)) continue;

      const album = await run.reads.albumDetails(albumId);
      if (!album) continue;
      const releaseDate = album.release_date;
      if (releaseDate.length === 10) {
        if (!validDates.includes(releaseDate)) continue;
      } else if (!releaseDateFallbackMatch(releaseDate, validDates)) {
        continue;
      }

      const primaryArtist = album.artists[0];
      const artistName = primaryArtist.name;
      const artistData = trustedArtists.artistCounts[artistName];

      const admit = (priority: number | 'editorial', score: number) => {
        foundReleases.set(albumId, {
          id: albumId,
          name: album.name,
          type: album.type,
          release_date: album.release_date,
          artistName,
          artistSpotifyId: primaryArtist.id,
          priority,
          score,
        });
        playlistsOf.set(albumId, [playlist.name]);
        releaseKeys.add(
          `${artistName.toLowerCase()}|${album.name.toLowerCase().trim()}`,
        );
        run.decisions.push({
          kind: 'release-found',
          artist: artistName,
          release: album.name,
          type: album.type,
          source: playlist.name,
        });
        run.onProgress?.({
          phase: 'release-found',
          artist: artistName,
          release: album.name,
          type: album.type,
          source: playlist.name,
        });
      };

      if (
        artistData &&
        (artistData.priority === 1 || artistData.priority === 2)
      ) {
        admit(artistData.priority, artistData.score);
      } else {
        const profile = await run.reads.artistProfile(primaryArtist.id);
        if (!profile) continue;
        const popular =
          profile.popularity >= editorial.gate.minPopularity ||
          profile.followers >= editorial.gate.minFollowers;
        if (
          popular &&
          isGenreAcceptable(profile.genres, editorial.genreFilters)
        ) {
          admit('editorial', 0);
        } else if (!hasRejectedGenre(profile.genres, editorial.genreFilters)) {
          const seenIn = [playlist.name];
          playlistsOf.set(albumId, seenIn);
          rejects.set(albumId, {
            albumId,
            artist: artistName,
            title: album.name,
            type: album.type,
            releaseDate: album.release_date,
            provenance: {
              kind: 'editorial-reject',
              reason: popular
                ? 'no accepted genre'
                : `popularity ${profile.popularity}`,
              playlists: seenIn,
            },
          });
        }
      }
    }
  }
  return { rejects: [...rejects.values()], playlistsOf };
}
