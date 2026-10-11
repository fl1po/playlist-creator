# Every Spotify call crosses one gateway, and the SDK exists only inside `call`

A single Spotify request used to pass through about a dozen thin modules (`spotify-context`, `api-wrapper`, `request-pacer`, `abort`, `spotify-client`, the task runner's abortable client, …). Pacing, retry, token refresh and abort were rules each caller had to remember, and the interface exposed the raw SDK (`ctx.api`, `client.api`). So the playback, album and search routes and a task's playlist write skipped the shared pacer that ADR-0003 depends on, ten call sites re-threw auth failures by hand, auth recovery happened in four places, and a stop was recognised by the message string `'Stopped by user'`. We replaced all of it with one module, `lib/spotify/`. Its interface is `call(api => …, description) → ApiResult<T>`. Losing auth for good throws `SpotifyAuthLost`, a stop throws `TaskAborted` (the abort signal's reason), and every other failure comes back as `{ success: false, kind }`. Behind the seam: one server-wide pacer with an **interactive** lane (routes) that is served before the **background** lane (tasks), retry and backoff, refresh ahead of a known expiry, one shared refresh and one shared login wait, and an app-level ban that background calls sleep through while interactive calls fail fast with `rate_limited` and `retryAt`. Each user session owns one gateway, which routes call directly. A task gets `gateway.forTask({ signal, onEvent })`, and the runner reports its events to the owner. The CLI gets `createCliGateway()`, which has no login, so a rejected refresh token ends the run.

## Considered options

- **Keep `ctx.api` alongside `call`**: rejected. Any getter that hands out the SDK lets a caller skip pacing, and that is exactly how the routes came to bypass ADR-0003's pacer.
- **Typed methods per endpoint on the gateway** (`gateway.getPlaylist(id)`, …): rejected. The interface would be about 20 methods wide, and the week-collection, promotion-sync and recalculation ports already provide typed reads on top of `call`.
- **Return auth loss as data** (the old `authError` flag): rejected. Every caller had to re-throw it, and several silently turned it into "no data". Nothing a caller does can recover from auth loss, so it throws.
- **Interactive calls wait like background ones**: rejected. During an hours-long ban an HTTP request would hang, and the 5-second playback poll would pile up waiting requests.
- **Separate pacer for interactive routes**: rejected for the same reason ADR-0003 shares one: Spotify's rate limit is per app, so an unpaced burst turns into a 429 that slows the running task.

## Consequences

- Routes now spend the shared rate budget. `/api/album` makes its calls one per interval instead of in a parallel burst, and the playback poll uses about a fifth of the 1 req/s budget while the page is open.
- `spotifyRoute` maps what escapes a route: `SpotifyAuthLost` → 401 `{ reauth: true }`, `rate_limited` → 429 with `retryAt`, other Spotify failures → 502.
- A fill that loses auth ends as failed instead of retrying the date. The gateway has already tried a refresh and a login by then, and week progress resumes the week next time.
- Every task's rate-limit waits reach its owner as `spotify:rateLimited` plus a log line. Before, only fill and listening-time reported them.
- Tests cross the same seam. The gateway's own tests use a fake SDK and clock (`sdk`, `grant` and `clock` are internal seams), and caller tests use `fixtureGateway(fakeApi)` in place of hand-written copies of the wrapper.
- The other hand-written accounts.spotify.com calls (code exchange, `/v1/me`, the browser's `/api/auth/refresh`) are still outside the gateway. The refresh grant's `ok | rejected | transient` outcome is the shape for merging them later.
