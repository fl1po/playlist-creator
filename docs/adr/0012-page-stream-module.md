# The page stream is one typed module the server and the page share; the page carries out its effects

The page's ~2,100-line inline script held the whole client half of the **page stream** (CONTEXT.md) with nothing to check it. It matched nine task result names by hand and read their payloads untyped. It also held the replay rules (no reloads while the first connection replays, reloads on a reconnect's replay), the rule that only a live dedup scan arms removal, and the guard that stops a replayed token push from looping reloads. It hard-coded the progress bar keys and copied three of the broadcaster's constants. Its only test checked that the script parses, so fixes to it ("no stale progress after replay", "log scroll fix") landed with no test. The drift was real: a clear forgot the week's AI picks but sent no result, so the page kept showing them.

We moved every rule about what a message means into one module, `web/page-stream/`. Its interface is:
- the `StreamMessage` union, built with `import type` from each task's own `…Results` interface (CONTEXT.md: *task result*), so a result's type stays next to its task;
- the history policy, which marks each message type `transient`, `replayed` or `kept`, together with the history limits, followed by both the broadcaster and the page's IndexedDB cache;
- `receive(state, message, page) → { state, effects }`, where `page` is what only the page knows: whether the session-expired banner is showing, the tokens it holds, and whether its own login popup is open.

The page is an adapter. It feeds every message to `receive` and carries out the effects (`reload`, `task`, `progress`, `marks`, `dedupArmed`, `show`, `log`, `resetLog`, `storeTokens`, `showSessionExpired`, `reloadPage`). The DOM work stays in the page: coalescing reloads, timers, diffing which bars are shown. There's no bundler. The page loads the module with a dynamic `import()` of tsc's own output, and the server serves exactly that file and its one value import (`lib/task-progress.js`) from `build/`.

## Considered options

- **Add esbuild and turn the whole page into TypeScript**: rejected for now. That's a much larger change and adds a build step to dev and the Dockerfile. This module doesn't rule it out.
- **A plain JS file in `public/` with JSDoc types**: rejected. It sits outside `rootDir`, and the server tasks couldn't import it cleanly for types.
- **A catalogue only** (result names, payload types and an `invalidates` table, with the page keeping its switch): rejected. The interface would be about as wide as the implementation, and the replay, arming and token rules would stay untested in the page.
- **One central `TaskResults` map that every task's `emit` is typed against**: rejected for the reason ADR-0007 rejected one renderer for every task. It would change with every task, and payload types would move away from their task. The union is assembled from the tasks instead.
- **Results that declare which page data they invalidate**: rejected. Page dataset names would leak into server tasks.
- **`receive` holds the listening-time and AW-breakdown results and joins them**: rejected. The join is presentation, and its inputs also come from HTTP loads, so the module would turn into a page-data store.
- **`receive` keeps its own copy of the token and banner state**: rejected. The page changes them in half a dozen places outside the stream, so it passes them in at each call instead.

## Consequences

- This extends ADR-0007. Log lines are still worded on the server, and what a result *does* on the page is now decided once, in `receive`, against a union that fails to compile when a new result isn't handled.
- `clear:complete` is a new task result. It is sent once the playlist is emptied, and it reloads AI picks.
- A message type the module doesn't know is `kept` by the server, as everything was before. A page running an older build ignores it.
- A new owner `status` naming `dedup-scan` disarms the previous scan, so the user's other pages disarm too. Before, only the clicking page did. A live scan with no duplicates now disarms an earlier armed scan.
- The page no longer accepts a bare-string `log` message. No server sender produces one.
- The page doesn't work until the module loads: the stream opens only after it has.
- `page-stream.test.ts` pins the rules through `receive`. The adapter itself is untested. It only carries out effects, so a mistake in it shows on the page rather than hiding in a rule.
