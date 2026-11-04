# Every read of a user's playlist tracks goes through one snapshot-checked module

Five places checked Spotify snapshot ids on their own, each with different rules: recalculation's AW/BoAW scan caches, the unprocessed listing's `WEEKLY_PLAYLIST_TRACKS` (ADR-0009), listening time's `DURATION_SNAPSHOTS`, AW breakdown, and the playback cache in `server.ts`. When the live snapshot couldn't be read, the first reused its stored copy, the next two refetched, AW breakdown stored `''`, and the playback cache was process-wide and FIFO-evicted. Nothing cached All Weekly's tracks, so a fill read it in full two or three times, and listening time, dedup and AW breakdown each read it again. Liked Songs (about 13k tracks, ~260 pages) was read in full whenever a single song was liked. Six readers in `pagination.ts` fetched the same unfiltered items and kept different fields.

We replaced all of it with one module, `lib/playlist-reads/`. `playlistReads(session)` binds it to a session's gateway; what it holds is shared by every binding over the same user data, so a route and a task of one user share it and building one is free. Its interface is `tracks(id, { snapshot? })`, which returns the playlist's slim items in order (empty slots kept for local files and episodes), plus a Liked Songs read. A read either completes or fails as `{ success: false, kind }`, never partially. Behind the seam:
- every read checks the live snapshot with one call (and once more after a full read, storing nothing if the playlist moved meanwhile), unless the caller already holds one, such as the user playlist listing or the playback route within its 60-second throttle;
- the tracks are kept by snapshot id in memory for the session, and in the `PLAYLIST_TRACKS` and `LIKED_SONGS_TRACKS` datasets;
- when the live snapshot can't be read, the module reads the playlist in full and doesn't store it;
- concurrent reads of the same playlist share one fetch;
- entries not read for 30 days are pruned;
- Liked Songs has no snapshot id, so it is keyed by `total:newest added_at` and read incrementally from the newest item. It falls back to a full read when the stored count plus the new items doesn't match the live total.

Callers build their own projections (ids, durations, positions, keys) from the items. The results computed from playlists are recomputed in memory instead of cached on their own snapshot checks. Listening time and AW breakdown keep only their last result, which the page shows with its age.

## Considered options

- **Cache only All Weekly**: rejected. It is the biggest single win, but it leaves four sets of snapshot rules in place and Liked Songs uncached.
- **Trust a copy in memory for one operation without checking**: rejected. The web session lives as long as the process, so this would need operation scoping first. One snapshot call per read is cheap, and the module can then never return a stale playlist.
- **Reuse the stored copy when the snapshot is unknown** (recalculation's old rule): rejected. Staleness is the one thing this module must never introduce, and a failed snapshot call is rare because the gateway already retries.
- **Projection methods on the module** (`trackIds`, `duration`, `withPositions`, …): rejected. The interface would be as wide as the six readers it replaces, and building a projection from items in memory is trivial.
- **Keep the derived scans' own snapshot caches on top**: rejected. No reader needs anything beyond the playlist items, so recomputing them is milliseconds.
- **Write-through on app writes**: rejected. A write changes the snapshot, and rereading a weekly playlist costs a page or two. Keeping writes out of the module keeps them from leaking into it.
- **One dataset for every playlist, or one dataset per playlist**: rejected. The first rewrites Liked Songs' megabytes on every weekly playlist save. The second needs keyed datasets, which would change the user data store's interface (ADR-0008).
- **A slimmer record just for Liked Songs**: rejected in favour of one record shape, with the store compressing large Redis values.
- **Editorial and scouting playlists**: left out. They aren't the user's playlists, they need album fields nothing else uses, and `rememberingReads` already reads each one once per fill.

## Consequences

- This changes parts of ADR-0009. `WEEKLY_PLAYLIST_TRACKS` and the "walked-only" pruning are gone, and the unprocessed listing passes the snapshot ids it already gets from the listing to `tracks`. ADR-0009's core rule stands: nothing invalidates, and any edit by anyone changes a snapshot.
- This extends ADR-0008. The user data store gzips the Redis copy of values over about 256 KB and marks them as compressed, while files on disk stay readable JSON. A Redis failure is now logged instead of swallowed silently. It still never fails a load or a save.
- `WEEKLY_PLAYLIST_TRACKS`, `DURATION_SNAPSHOTS` and recalculation's `awScanCache`/`boawScanCache` leave the catalogue without a shim, along with the legacy migration of the BATCH_CACHE scan fields. The first read after the deploy is cold: about 260 pages for Liked Songs plus about 20 for All Weekly, paid once.
- Lenient reads are gone. A caller that used to degrade on a partial playlist now fails, and a recalculation or task that fails this way simply runs again next time.
- The module's suite counts calls over a fake gateway, with a local store over a temp dir. One fill test counts All Weekly page reads, so the number of reads is pinned.
