# The unprocessed listing checks Spotify's snapshot ids; writers never invalidate it

The unprocessed weekly playlists (CONTEXT.md) were a cached listing kept until All Weekly changed or a writer dropped it. Each writer had to remember to do that. The fill did it through an `invalidateUnprocessed` dep threaded into the weekly playlists module, promotion sync through `UnprocessedPlaylists.invalidate`, and dedup-remove in its `cleanup`. Clear didn't. A cleared weekly playlist stayed "unprocessed" until the user next listened, so a promotion sync could backfill it, and the next fill then saw that Friday as filled and skipped it. Edits made in Spotify itself were never seen at all. The drop also deleted the listening time result, which is another task's dataset.

We moved the listing into the weekly playlists module as `unprocessedWeeklyPlaylists`, and it now checks itself. Every read lists the user's playlists, which carry Spotify's `snapshot_id`, and reads All Weekly fresh. It caches each walked weekly playlist's track ids by snapshot id (`WEEKLY_PLAYLIST_TRACKS`), and rereads a playlist only when its snapshot changed. Overlap with All Weekly is checked in memory on every read. Any edit by anyone changes a snapshot, so nothing has to invalidate the listing. `WeeklyPlaylistStore` gained `trackIds`, and its `list` returns snapshot ids. Recalculation's `UnprocessedPlaylists` port shrank to `find`.

## Considered options

- **Route every write through the weekly playlists module and invalidate there**: rejected. Locality would depend on every future writer going through the module, and it can never see edits made outside the app.
- **Cache the listing whole, keyed by All Weekly plus every snapshot id**: rejected for the per-playlist cache. Every listen changes All Weekly and would force a full rescan. Track ids by snapshot don't depend on All Weekly, so a listen costs no playlist reads and a fill rereads only the playlist it wrote.
- **Cache per-playlist overlap results**: rejected for the same reason. The result depends on All Weekly, so every listen voids it.

## Consequences

- Each read costs one paged playlist listing (a few requests) that a cache hit used to skip. A cache hit still read All Weekly in full, so the added share is small.
- Listening time is a plain last result. It is never deleted, carries `computedAt`, and the page shows its age. Before, an app write dropped it but a listen didn't.
- The old `nonListened` dataset left the catalogue without a shim. Its files and Redis keys are orphaned, and the first read after the deploy is a cold scan.
- A playlist without a snapshot id is read every time and never cached.
