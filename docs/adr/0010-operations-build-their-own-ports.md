# Each operation builds its own ports from a user session; the roots only choose a sink

The CLI and the web tasks each assembled the fill, recalculation and clear themselves. Each built `DurableFillStorage`, called `fillPorts` and `spotifyRecalculationPorts`, loaded the user's config, and read whether the server had an Anthropic key. Each also ran its own follow-up rules, and the two roots drifted. The web clear forgot the cleared weekly playlist's AI picks and the CLI clear didn't, so a CLI clear left an unfilled Friday with an AI-picks record. We moved that assembly into the operations themselves. A `UserSession` (`lib/user-session.ts`) is the gateway, the user id and the user data. The CLI builds it once with `cliSession()` (always local user data, per ADR-0008), and a task gets it as `tc.session`. `runFill(run, ports = fillPorts(run))`, `recalculate(session, opts, ports?)`, `syncPending(session, onProgress, ports?)` and `new PlaylistClearerService(session)` load the config, build their storage and production ports, and run their own follow-up rules. Clear forgets the AI picks after its last removal. A root now only parses its arguments and chooses a sink.

## Considered options

- **A separate operations module (`fill`, `recalculateAndSync`, `clearWeekly`) that both roots call**: rejected. It would mostly forward to `runFill`, `recalculate`/`syncPending` and the clear. Deleting it would remove nothing, and each rule would sit one module away from the concept it belongs to. Putting the assembly in the operations themselves means each one's existing suite tests its rules.
- **A combined `recalculateAndSync`**: rejected. ADR-0002 made recalculate and sync two operations on purpose, and the fill needs them apart. The CLI's `--no-sync` simply doesn't call `syncPending`.
- **"Clear weekly playlist" in the weekly playlists module**: rejected for now. Clear still empties any playlist by name. Picks are kept by weekly playlist name, so clearing any other playlist has no picks to forget.
- **Keep `aiFindsAvailable` / `hasApiKey` as flags beside the ports**: rejected. A flag beside the ports could disagree with them. `fillPorts(session, env)` builds AI finds' ports only when `env` has a key. An enabled AI phase in week collection with no candidate and judge ports records the week `no-api-key`.
- **Keep the in-memory `FillStorage` fixture**: rejected. A local store over a temp dir is the faithful stand-in (ADR-0008), and tests read `FILL_HISTORY` from it. `FillStorage` stays as the fill's own seam over the store.

## Consequences

- `tc.ctx`, `tc.userId` and `tc.data` are gone; every task reaches its gateway and user data through `tc.session`.
- Tests that need different config save it to the temp store before the run. `userConfig` is no longer an input.
- A mid-fill recalculation reads the config again, so a config saved during a fill reaches the next week's recalculation. The fill's own reads (editorial, AI finds) still use the config it loaded at the start.
- Production ports stay overridable through the last argument. Inside a fill that argument isn't only for tests: the fill passes the recalculation ports it already holds.
