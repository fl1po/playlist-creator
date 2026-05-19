import { type PageOpts, paginateReduce } from '../lib/pagination.js';
import type { SpotifyContext } from '../lib/spotify-context.js';
import { formatDdMmYy, parseDate, toReleaseFriday } from './tracks.js';

type Item = any;

export interface FrequentArtistEntry {
  label: string; // "Artist (N)"
  album: string;
}

export interface WeekBreakdownEntry {
  date: string; // dd.mm.yy release week
  addedAt: string; // dd.mm.yy date added to AW
  trackCount: number;
  durationMs: number;
  albumCount: number;
  albumTracks: number;
  frequentArtists: FrequentArtistEntry[];
}

interface RawTrack {
  durationMs: number;
  artists: string[];
  albumId: string;
  albumArtist: string;
  albumName: string;
  addedAtDate: string; // YYYY-MM-DD or 'unknown'
}

function trackFriday(releaseDate: string | undefined, addedAt: string): string {
  if (releaseDate) return formatDdMmYy(toReleaseFriday(new Date(releaseDate)));
  if (addedAt !== 'unknown')
    return formatDdMmYy(toReleaseFriday(new Date(addedAt)));
  return 'unknown';
}

/** Get all tracks from a playlist grouped by release week. */
export async function getPlaylistTracksGroupedByWeek(
  ctx: SpotifyContext,
  playlistId: string,
  opts?: PageOpts,
): Promise<WeekBreakdownEntry[]> {
  const { byFriday, addedAtCounts } = await paginateReduce(
    ctx,
    {
      fetch: (l, o) =>
        ctx.api.playlists.getPlaylistItems(
          playlistId,
          undefined,
          undefined,
          l,
          o,
        ),
      description: `playlist tracks grouped ${playlistId}`,
    },
    () => ({
      byFriday: new Map<string, RawTrack[]>(),
      addedAtCounts: new Map<string, Map<string, number>>(),
    }),
    (acc, rawItem) => {
      const item = rawItem as Item;
      if (!item.track) return;
      const addedAt = item.added_at as string | undefined;
      const addedAtDate = addedAt ? addedAt.slice(0, 10) : 'unknown';
      const durationMs = item.track.duration_ms ?? 0;
      const artists = (item.track.artists as Array<{ name: string }>).map(
        (a) => a.name,
      );
      const album = item.track.album as
        | {
            id?: string;
            name?: string;
            release_date?: string;
            artists?: Array<{ name: string }>;
          }
        | undefined;
      const releaseDate = album?.release_date;
      const albumId = album?.id ?? '';
      const albumArtist = album?.artists?.[0]?.name ?? '';
      const albumName = album?.name ?? '';

      const fri = trackFriday(releaseDate, addedAtDate);
      if (!acc.byFriday.has(fri)) acc.byFriday.set(fri, []);
      acc.byFriday.get(fri)?.push({
        durationMs,
        artists,
        albumId,
        albumArtist,
        albumName,
        addedAtDate,
      });

      if (!acc.addedAtCounts.has(fri)) acc.addedAtCounts.set(fri, new Map());
      const counts = acc.addedAtCounts.get(fri);
      counts?.set(addedAtDate, (counts.get(addedAtDate) ?? 0) + 1);
    },
    opts,
  );

  const sortedFridays = [...byFriday.keys()]
    .filter((f) => f !== 'unknown')
    .map((f) => ({ label: f, time: parseDate(f).getTime() }))
    .sort((a, b) => a.time - b.time)
    .map((f) => f.label);

  const unknownTracks = byFriday.get('unknown');
  if (unknownTracks?.length && sortedFridays.length > 0) {
    const lastFri = sortedFridays[sortedFridays.length - 1];
    byFriday.get(lastFri)?.push(...unknownTracks);
  } else if (unknownTracks?.length) {
    sortedFridays.push('unknown');
  }

  return sortedFridays.map((dateLabel) => {
    const tracks = byFriday.get(dateLabel) ?? [];

    const counts = addedAtCounts.get(dateLabel);
    let topAdded = 'unknown';
    let topCount = 0;
    if (counts) {
      for (const [date, count] of counts) {
        if (count > topCount) {
          topCount = count;
          topAdded = date;
        }
      }
    }
    const addedAt =
      topAdded === 'unknown' ? 'unknown' : formatDdMmYy(new Date(topAdded));

    const trackCount = tracks.length;
    const durationMs = tracks.reduce((s, t) => s + t.durationMs, 0);

    const albumTrackCounts = new Map<string, number>();
    const albumMeta = new Map<string, { artist: string; name: string }>();
    for (const t of tracks) {
      if (!t.albumId) continue;
      albumTrackCounts.set(
        t.albumId,
        (albumTrackCounts.get(t.albumId) ?? 0) + 1,
      );
      if (!albumMeta.has(t.albumId))
        albumMeta.set(t.albumId, { artist: t.albumArtist, name: t.albumName });
    }
    const repeatAlbumIds = new Set<string>();
    const frequentEntries: { artist: string; album: string; count: number }[] =
      [];
    for (const [albumId, count] of albumTrackCounts) {
      if (count < 3) continue;
      repeatAlbumIds.add(albumId);
      const meta = albumMeta.get(albumId);
      if (meta)
        frequentEntries.push({ artist: meta.artist, album: meta.name, count });
    }
    frequentEntries.sort(
      (a, b) => b.count - a.count || a.artist.localeCompare(b.artist),
    );
    const frequentArtists: FrequentArtistEntry[] = frequentEntries.map((e) => ({
      label: `${e.artist} (${e.count})`,
      album: e.album,
    }));
    const albumCount = repeatAlbumIds.size;
    let albumTracks = 0;
    for (const t of tracks) {
      if (t.albumId && repeatAlbumIds.has(t.albumId)) albumTracks++;
    }

    return {
      date: dateLabel,
      addedAt,
      trackCount,
      durationMs,
      albumCount,
      albumTracks,
      frequentArtists,
    };
  });
}
