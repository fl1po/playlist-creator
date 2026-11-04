import type { PlaylistItem } from '../lib/playlist-reads/index.js';
import { trackKey } from '../lib/track-utils.js';

/*
 * Duplicates in a weekly playlist: tracks with the same artists and title.
 * The first one stays; every later one goes. The scan and the removal share
 * this rule, so the removal takes away exactly what the scan reported.
 */

export interface DuplicateGroup {
  artists: string;
  name: string;
  /** The copy that stays: the first one in the playlist. */
  keep: { uri: string; position: number };
  /** The later copies, in playlist order. */
  extra: Array<{ uri: string; position: number }>;
}

/** Every group of duplicates, in the order of the copy each one keeps. */
export function findDuplicates(items: PlaylistItem[]): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  items.forEach(({ track, uri }, position) => {
    if (!(track && uri)) return;
    const artistNames = track.artists.map((a) => a.name);
    const key = trackKey(artistNames, track.name);
    const group = groups.get(key);
    if (group) group.extra.push({ uri, position });
    else
      groups.set(key, {
        artists: artistNames.join(', '),
        name: track.name,
        keep: { uri, position },
        extra: [],
      });
  });
  return [...groups.values()].filter((g) => g.extra.length > 0);
}

/**
 * The two playlist writes a removal needs. Spotify removes a track by uri,
 * which takes every copy of it; `insert` puts one back at a position.
 */
export interface DedupWrites {
  removeAll(uri: string): Promise<void>;
  insert(uri: string, position: number): Promise<void>;
}

/**
 * Remove every later copy in `groups` from the playlist `items` came from.
 * When a later copy has the kept copy's own uri, removing it takes the kept
 * one too, so that one is put straight back where it was. One uri at a time,
 * so a stop between the two writes can lose at most that one track. Returns
 * how many tracks left the playlist.
 */
export async function removeDuplicates(
  items: PlaylistItem[],
  groups: DuplicateGroup[],
  writes: DedupWrites,
): Promise<number> {
  // The playlist as it stands after each write, so positions stay exact.
  const uris = items.map((i) => i.uri);
  let removed = 0;
  for (const group of groups) {
    for (const uri of new Set(group.extra.map((e) => e.uri))) {
      const keptAt = uri === group.keep.uri ? uris.indexOf(uri) : -1;
      const copies = uris.filter((u) => u === uri).length;
      await writes.removeAll(uri);
      for (let i = uris.length - 1; i >= 0; i--) {
        if (uris[i] === uri) uris.splice(i, 1);
      }
      removed += copies;
      if (keptAt >= 0) {
        await writes.insert(uri, keptAt);
        uris.splice(keptAt, 0, uri);
        removed--;
      }
    }
  }
  return removed;
}
