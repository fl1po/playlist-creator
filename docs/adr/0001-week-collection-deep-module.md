# Week collection is one deep, stateless module behind three ports

The week collection (one Friday's release gathering: P1/P2 artist search, editorial merge, variant choice, popularity gate, deluxe/title-track/history dedup, track ordering) was split between `ReleaseCollector` and ~170 inlined lines of `date-pipeline.ts`, with decisions leaking through callbacks and a caller-owned mutable `TrackDedup`. We consolidated it into a single stateless entry point — `collectWeek(input, ports, onProgress?) → WeekCollection` — that returns collection decisions as data and hides checkpoint cadence, resume, and all release decisions behind the seam. Three ports: `ReleaseReads` (7 Spotify reads; prod adapter wraps SpotifyContext + pagination, test adapter is a fixture catalog), `PopularitySource` (Deezer / fixed map), `CheckpointStore` (file + Redis via FillStorage / in-memory). Pure deciders stay in `domain/releases` as an internal seam. The interface is the test surface.

## Considered options

- **Plug-in protocols for sources and filters** (a `ReleaseSource` port where artist search and editorial are adapters, plus composable `ReleaseFilter` stages): rejected because both would be single-adapter seams today — no third source exists, and the two filters always run in the same order. One adapter means a hypothetical seam; revisit only when a third release source actually materializes.
- **Stateful factory with `collect(date)` + `rebind(roster)` and collector-owned listening-history mutation**: rejected because it makes results order-sensitive, and history mutation across weeks would be a silent behavior change — `allWeeklyTracks` is loaded once per fill and weeks do not dedup against each other today. The factory's per-week ergonomics are achieved instead by a binding closure in `fill-run`, keeping the module a pure function.

## Consequences

- `playlist-syncer.ts` still uses the old `ReleaseCollector` for promotion-sync; it should migrate to `ReleaseReads` + the domain deciders (a thinner slice — no editorial, no checkpoints, no Friday window) rather than forcing mode flags into `collectWeek`. Until then `release-collector.ts` stays for the syncer only.
- Liveness reaches the UI through one narrow `onProgress` callback (phase + counts); collection decisions are not duplicated there, so decision detail renders when the week completes.
