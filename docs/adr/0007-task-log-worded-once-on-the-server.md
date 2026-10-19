# A task's log is worded once, on the server, from typed task events

The same collection decision used to be turned into text in four places: `fill-run`'s `emitProgress`/`emitDecision`, the CLI subscribers, the browser's `handleMessage` switch, and promotion sync's `describeDecision`. Each copy drifted. The web showed "Sync complete" twice, the CLI never showed title-track-only, sync dropped three decision kinds, every surface said "Found:" for releases that might never land, and the export didn't match the panel. Every message also had to carry `ts` and `task` because the page built log lines out of task events. We made each task emit one discriminated union of its domain events (`FillEvent` wraps `WeekProgressEvent`, `CollectionDecision`, `WeeklyWrite`, `DateResult`, …) instead of a positional event map. Each owner renders its own union with `describe(event) → LogLine[]`, an exhaustive switch next to the type. Collection decisions are rendered once in `week-collection/`, and fill and promotion sync share that renderer. The CLI prints those lines, and the web sink broadcasts them as plain `log` messages. A result the page acts on (`fill:complete`, `dedup:scanComplete`, …) goes out as a separate message carrying only data. The browser no longer holds any task's wording.

## Considered options

- **Keep the event maps and share only the text functions**: rejected. The positional tuples re-encoded typed data, and that re-encoding is where kinds got dropped and renamed. A union gets an exhaustiveness check for free.
- **Results carry a `lines` field that the browser logs generically**: rejected. Every message type would then have two meanings, and the browser would again decide what a message renders as.
- **CLI-only decoration (banners, `heading` lines) or separate CLI templates**: rejected. One output per event is what keeps the CLI, the panel and the export identical, and what makes one table test enough. A `heading` level can still be added without moving the seam.
- **One task-log module rendering every task**: rejected. It would import every task's types and change with each of them. The switch belongs next to the union it checks.
- **Convert or shim the old history**: rejected. History lasts 7 days and is only diagnostic. Old task events render nothing after the deploy, and the log cache version bump resets each browser's copy.

## Consequences

- During the search the live line says "Discovered"; a `release-found` decision says "Added" after the week (CONTEXT.md: *found* means landed).
- Which results stay in history is unchanged. Making the ones that only drive live behaviour transient is part of the replay protocol, not this decision.
- `broadcastEvents` and the fill's and clearer's event maps are gone. `ServiceEmitter` stays for artist lookup, which isn't a task.
