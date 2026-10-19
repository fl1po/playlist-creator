# Task progress is task-runner state, shown only to the owner and never replayed

The page used to rebuild a running task's progress by replaying the live log through its live handlers. The high-frequency progress events were kept out of history, so the gaps were patched by hand: a `fill:searchedArtists` snapshot in `server.ts` (sent to every connecting client, against ADR-0003's owner-only rule), a module-level Set in the fill task, and client-side clearing on `replay:done`, `fill:complete`, `fill:stopped` and `server:restarted`. Bars from finished runs kept reappearing after a reload. We made progress the task runner's own state. A task reports it through `tc.progress` (`steps`, `step`, `bar`, `clearBar`, `mark`). The runner adds `waitUntil` from the gateway's rate-limit events and carries the record in the owner's variant of `TaskStatus`, so `statusFor` is the one place that decides who sees it. Progress events are no longer messages, and the record is dropped when the task ends. "Nothing running" and "nothing drawn" are therefore the same fact, and a restarted server has no progress to clean up.

## Considered options

- **Snapshot on connect, keep the live progress events**: rejected. The page would need two paths that must agree, rebuilding from the snapshot and applying live events, and that disagreement is what kept producing stale progress.
- **Persist progress events in history**: rejected. A replay can't tell a live run from a finished or cut-off one without the runner's knowledge, and history is per user while ADR-0003 restricts what a task reveals to its owner.
- **A typed progress view per task**: rejected for now. Every progress surface fits generic steps, bars, marks and a wait, so a per-task seam would have one adapter.
- **Keep the last record after the task ends**: rejected. Every page load would have to decide whether a finished run is stale. The outcome stays in the log.
- **A `progress` port on `runFill`**: rejected. It would have one meaningful adapter. The web fill subscriber translates fill events into `tc.progress` calls, and the CLI is unchanged.

## Consequences

- Live `status` frames carry `marked` as `markedAdded` deltas. Only the connect snapshot and the start of a run carry the full list.
- Completion events (`fill:complete`, `fill:recalculated`, the dedup scan result) stay in history to trigger data reloads, still guarded by `initialReplay`. They are task results, not progress.
