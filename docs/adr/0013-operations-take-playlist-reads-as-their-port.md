# Operations take playlist reads as their read port

ADR-0011 put every read of a user's playlist tracks behind `lib/playlist-reads/`, but each operation still reached it through a port of its own: recalculation's `SourceReads` (`snapshots` + `scan`), promotion sync's `PromotionReads.playlistTrackIds` / `playlistTracksWithArtists`, the weekly playlists module's `WeeklyPlaylistStore.trackIds`, and the fill's `history`. Each was a few lines over `playlistReads`, each needed its own fake, and `memoryWeeklyPlaylistStore` re-implemented snapshot versioning. Recalculation's `snapshots` also kept a second copy of the snapshot check and of the Liked Songs key (`total:newest added_at`), with a different failure rule, and cost about three snapshot calls per source.

Operations now take `PlaylistReads` itself. `PromotionSyncPorts`, `RecalculationPorts` and `FillPorts` each carry a `playlists: PlaylistReads` field, and the weekly playlists module takes one beside its store; `PromotionReads` is plain `ReleaseReads` again, and `SourceReads` and `WeeklyPlaylistStore.trackIds` are gone. In production every field is `playlistReads(session)`, which is free to build and shares what it holds per user's data, so ADR-0010's shape (each operation builds its own ports from a session) stands. Projections (track ids, the scoring scan, tracks with artists) are built by each operation from the items, as ADR-0011 intended.

Recalculation decides whether a source changed by comparing `read.snapshot` with the snapshot it stored in `RECALCULATION_STATE`, never by `read.cached`: a cached read only means someone read that snapshot, not that recalculation scored it. A short read (`missing > 0`) is scored but its snapshot isn't recorded, so the next recalculation scores the source again, the way playlist reads never stores a short read.

Operation tests fake reads with one in-memory playlists fixture (`src/tests/fixtures/memory-playlists.ts`) that gives a `PlaylistReads`, a `WeeklyPlaylistStore` and `PlaylistWrites` over the same playlists, whose snapshots change on every write or outside edit. Snapshot caching, torn reads and Liked Songs keys are tested only in playlist reads' own suite.

## Considered options

- **Narrow read ports per operation** (what this replaces): rejected. Each was a pass-through, failing the deletion test, and they're where a second snapshot rule crept back in.
- **Fake reads through `fixtureGateway` and the real `playlistReads`**: rejected. Every operation suite would describe Spotify's pages and snapshot responses, and re-test playlist reads' rules.
- **One instance at the top, threaded into recalculation and sync as an argument**: rejected. It gives `recalculate` and `syncPriorityChanges` a parameter outside their ports, unlike every other operation (ADR-0010).
- **Separate in-memory fakes for reads, store and writes, wired by each test**: rejected. A test that forgets the wiring gets reads that disagree with its writes.
- **Fail a recalculation on a short read**: rejected. Spotify leaves items out of untouched playlists, so one bad item could block recalculation indefinitely.

## Consequences

- `RecalculationPorts.unprocessed` stays a port for now; where the unprocessed listing is assembled is a separate question.
