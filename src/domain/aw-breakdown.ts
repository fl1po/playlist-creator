import type { PlaylistItem } from '../lib/playlist-reads/index.js';
import { formatDdMmYy, parseDate, toReleaseFriday } from './tracks.js';

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

/**
 * A playlist's tracks grouped by release week — the Friday of the album's
 * release date, falling back to the date added. Tracks with neither are
 * folded into the latest week.
 */
export function groupTracksByWeek(items: PlaylistItem[]): WeekBreakdownEntry[] {
  const byFriday = new Map<string, RawTrack[]>();
  const addedAtCounts = new Map<string, Map<string, number>>();
  for (const item of items) {
    const { track } = item;
    if (!track) continue;
    const addedAtDate = item.addedAt ? item.addedAt.slice(0, 10) : 'unknown';
    const fri = trackFriday(track.album.releaseDate || undefined, addedAtDate);
    if (!byFriday.has(fri)) byFriday.set(fri, []);
    byFriday.get(fri)?.push({
      durationMs: track.durationMs,
      artists: track.artists.map((a) => a.name),
      albumId: track.album.id,
      albumArtist: track.album.artistNames[0] ?? '',
      albumName: track.album.name,
      addedAtDate,
    });

    if (!addedAtCounts.has(fri)) addedAtCounts.set(fri, new Map());
    const counts = addedAtCounts.get(fri);
    counts?.set(addedAtDate, (counts.get(addedAtDate) ?? 0) + 1);
  }

  const sortedFridays = [...byFriday.keys()]
    .filter((f) => f !== 'unknown')
    .map((f) => ({ label: f, time: parseDate(f).getTime() }))
    .sort((a, b) => a.time - b.time)
    .map((f) => f.label);

  // Undated tracks join the latest week rather than getting their own bucket.
  const unknownTracks = byFriday.get('unknown');
  if (unknownTracks?.length && sortedFridays.length > 0) {
    const lastFri = sortedFridays[sortedFridays.length - 1];
    byFriday.get(lastFri)?.push(...unknownTracks);
  } else if (unknownTracks?.length) {
    sortedFridays.push('unknown');
  }

  return sortedFridays.map((dateLabel) => {
    const tracks = byFriday.get(dateLabel) ?? [];

    // The week's addedAt is the most common add date among its tracks.
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
    // An album with 3+ tracks in the week counts as listened-to as an album.
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
