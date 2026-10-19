# Log loading performance: why a refresh is slow and what to do about it

Research date: 2026-10-19. State of the code: `130edf6` ("added deploy log").

Complaint: every page refresh refetches the whole log, and that is slow once the log gets long.

**Summary.** The log is not fetched over a separate HTTP request. It is the **replay at the start of the SSE stream** (`/api/events`). On every refresh the server sends the user's whole in-memory history again: up to 2000 frames, uncompressed. The client renders each frame one at a time and forces a layout after every line. Three things drive the cost. The first is the most important, and nobody would guess it:

1. **The replay carries multi-megabyte `data:save` frames.** These are the browser's localStorage mirror, not log lines. A fill checkpoint re-sends the whole `batchCache` (about 765 KB) every 50 artists searched. All of these frames are kept in the replay history and sent again on every refresh.
2. **The stream is not compressed.** The compression middleware leaves `/api/events` out on purpose.
3. **The client renders line by line.** It does a forced synchronous layout per line, a `toLocaleTimeString` call per line, and fires network side effects when it replays old completion events.
   - Also, the stream does not start until a serial waterfall ends: `/api/auth/status` (a Spotify round trip), then `/api/export-data` (about 1.7 MB of JSON), then `/api/events/ticket`, then the stream.

SSR is not a good fit here (see §4.8). The fixes that pay off are mostly small and local.

---

## 1. Current implementation

### Stack and hosting
- Node ≥22 and Express 5 (`package.json`). The `compression` middleware (^1.8.2) is used. There is no front-end framework. The UI is one static file, `src/web/public/index.html` (3258 lines, inline `<script>`), served by `express.static` (`src/web/server.ts:126`).
- The app deploys to **Railway** through `Dockerfile` and `railway.json`. Railway's edge supports HTTP/1.1 and HTTP/2. It closes requests after 15 min even when data keeps flowing, and after 5 min with no data ([Railway specs & limits](https://docs.railway.com/networking/public-networking/specs-and-limits)).
- The durable log store is Upstash Redis over REST (`src/web/log-store.ts`).

### Producing log entries
- `broadcaster.broadcastTo(userId, type, data, task)` (`src/web/broadcast.ts:141-173`) serialises `{type, data, ts, task}` once. It numbers the message with a clock-based `seq` that keeps rising across restarts (`:102-107`). Then it:
  - pushes it to an **in-memory per-user history**, capped at `MAX_LOG_HISTORY = 2000` entries by count, not by bytes (`:66-67`, `:160-164`). Only the types in `SKIP_HISTORY` are left out (`:84-91`).
  - queues it for Redis, except `data:save`. `SKIP_PERSIST` (`:94`) skips **persisting** only. `data:save` is still kept in the in-memory replay history.
- `data:save` comes from `DurableCache.save` → `onSave` (`src/lib/durable-cache.ts:162-164`, wired in `src/web/task-runner.ts:248-252`). Only `relatedArtistGraph` opts out with `browserMirror: false` (`src/lib/cache-files.ts:129`). During a fill, the week collector checkpoints every `CHECKPOINT_EVERY = 50` searched artists (`src/services/week-collection/index.ts:447,537`). Each checkpoint calls `storage.saveBatchCache` (`src/services/playlist-filler/adapters.ts:38-46` → `storage.ts:63-65`), and that **broadcasts the whole `batchCache` object**. Recalculation saves `trustedArtists` the same way (`src/services/recalculation/index.ts:309`).

### Persistence
- Upstash keeps one Redis list per user per UTC day, `log:<user>:<YYYY-MM-DD>`, with an 8-day TTL (`log-store.ts:26-98`). The broadcaster flushes pending entries every 10 s and on SIGTERM (`server.ts:61-68`).
- Redis is read **only** at boot (`restore`, `broadcast.ts:237-247`, which loads the last week and keeps the newest 2000) and for the "download log" export (`week()`, `:249-255`; `/api/logs/export`, `server.ts:320-342`). **A page refresh never touches Redis.** The replay comes from memory, so the server-side read cost on refresh is close to zero.

### Serving
- `GET /api/events` (`server.ts:142-177`) uses `text/event-stream` and `Cache-Control: no-cache`. It calls `broadcaster.addClient(res, userId, req.headers['last-event-id'])`, which writes the snapshot frames and then **every history entry with `seq > lastEventId`**, one `res.write` per entry (`broadcast.ts:188-207`).
- Compression is turned off for this route: `compression({ filter: (req) => !req.url.startsWith('/api/events') })` (`server.ts:117-121`).
- Resume only works inside one `EventSource` object. The browser sends `Last-Event-ID` only when that object *re-establishes* its connection ([WHATWG HTML §9.2](https://html.spec.whatwg.org/multipage/server-sent-events.html)). A new `EventSource` after a reload starts with an empty last-event-ID, and the constructor can't set headers: its only option is `withCredentials` ([MDN EventSource()](https://developer.mozilla.org/en-US/docs/Web/API/EventSource/EventSource)). So **every reload gets `from = 0` and a full replay.** The test `a reconnecting client resumes instead of replaying the whole log` (`src/tests/broadcast.test.ts:65`) covers only the in-object reconnect.

### Client
- Startup (`index.html:3245-3257`) runs `checkAuth()` first:
  1. `GET /api/auth/status`. This always calls Spotify `/v1/me` with no cache (`src/web/routes/auth.ts:53-90`).
  2. `syncDataFromServer()` → `GET /api/export-data` (`index.html:1759,1765`). This returns `trustedArtists`, `batchCache` and the rest, about 1.7 MB raw for the local `fl1po` data, read from files or Redis (`server.ts:214-249`).
  
  Only after that does `connect()` run `GET /api/events/ticket` and then `new EventSource` (`index.html:1219-1226`).
- `es.onmessage` (`:1255-1268`) parses each frame with `JSON.parse` and dispatches it to `handleMessage`. For a log line, `log()` (`:2229-2261`) does the following:
  - creates a `div`;
  - scans all `<option>`s for the filter (`:2263-2267`);
  - calls `toLocaleTimeString`/`toLocaleDateString`;
  - escapes the text through a throwaway `div` (`esc`, `:2306-2310`);
  - walks back siblings to insert in timestamp order;
  - **sets `panel.scrollTop = panel.scrollHeight` per line** when auto-scroll is on, which is the default.
- Replayed `data:save` frames run `Store.set` → `localStorage.setItem(JSON.stringify(value))` (`:1538-1542`, `:1107-1110`). The UI never reads `batchCache` from localStorage. It reads only `config`, `listeningTime`, `awBreakdown`, `trustedArtists`, `pinnedBlocks` and the tokens.
- Replayed completion events also run their **side effects** again: `fill:complete` → `loadArtists()`, `loadAiPicks()`, `loadStats()` (`:1332-1351`); `fill:stopped` (`:1353-1366`); `fill:recalculated` (`:1389`); `recalc:complete` (`:1432-1437`). A history with N fills makes about 2-3·N extra API calls on every refresh.
- The DOM is unbounded: the server sends up to 2000 entries, and many events produce several lines each. There is no virtualisation and no `content-visibility`.

### Sizes (measured on `data/users/fl1po`, local snapshot from June)
| Payload | Raw | gzip -6 | brotli q5 |
|---|---|---|---|
| `batch-cache.json` (one `data:save` frame) | 764,605 B | 133,893 B | 114,031 B |
| `trusted-artists.json` | 970,941 B | 126,690 B | 118,903 B |

The roster has 355 P1 and 586 P2 artists (941 total), from the `trusted-artists.json` metadata. The fill searches P1/P2 (`fill-run.ts:498`), so **one filled week makes about 19 checkpoints**. Each checkpoint is a ~765 KB `data:save` frame, about **14 MB of replay per filled week**, kept until the next deploy or until 2000 newer entries push it out. An ordinary log line frame is about 150-250 B, so 2000 pure log lines would be only about 0.3-0.5 MB.

## 2. Where the time goes (in order of likely impact)

1. **Payload bloat from `data:save` in the replay history.** This is megabytes to tens of megabytes of uncompressed JSON, sent on every refresh over a stream that may not be on HTTP/2. The data is redundant: the same page load already got `trustedArtists` and `batchCache` from `/api/export-data`.
2. **Main-thread cost on the client.** For each large frame the client runs `JSON.parse`, then `JSON.stringify`, then a synchronous `localStorage.setItem`. The 5 MiB localStorage quota ([MDN storage quotas](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)) can also throw `QuotaExceededError` in the middle of the replay. For each log line, the client writes to the DOM and then reads `scrollHeight`, which is the forced-synchronous-layout/layout-thrashing pattern ([web.dev](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing)). On top of that it calls `toLocaleTimeString`, which MDN says looks up a "big database of localization strings" on every call ([MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/toLocaleTimeString)).
3. **No compression on the stream** (`server.ts:117-121`). Log text and JSON compress about 6-8x (see the table above).
4. **A startup waterfall before the stream can start:** a Spotify `/me` round trip, then the ~1.7 MB `/api/export-data`, then the ticket.
5. **Replay side effects** that start extra API requests while the replay runs.
6. **No incremental fetch after a reload.** Resume works only inside one `EventSource` object.

The server doesn't add much: the history is in memory and `res.write` is cheap. Redis is not on the refresh path.

## 3. Options

Each option says what it is, how it applies here, the expected win, the cost, and the caveats.

### 3.1 Drop `data:save` from the replay history (or coalesce it), and stop mirroring data the UI never reads
- **What.** Treat `data:save` as live-only, the way `status` and `reload` already are. If you must keep something for reconnects, keep only the newest value per key.
- **Where.** `src/web/broadcast.ts:84-94`, plus `browserMirror: false` on `BATCH_CACHE` in `src/lib/cache-files.ts:28-32`.
  - Option A: add `'data:save'` to `SKIP_HISTORY`.
  - Option B (safer for tokens): store `data:save` in a separate `Map<userId, Map<key, entry>>` and replay only the newest entry per key, and only on a resume (`Last-Event-ID` present). A fresh connect already gets the datasets from `/api/export-data`.
  - Since the UI never reads `sp_batchCache`, `browserMirror: false` on `BATCH_CACHE` removes the biggest frames at the source. Leave it in `syncDataFromServer`'s key list only if something still needs it (nothing in `index.html` reads it).
- **Win.** The largest by far. It can cut the replay from tens of MB to a few hundred KB, and it removes most of the client's JSON and localStorage work.
- **Cost.** A few lines plus a test in `src/tests/broadcast.test.ts`.
- **Caveat.** `data:save` for `tokens` matters to a client that was disconnected while tokens were refreshed. `bearer-identity.ts` refreshes again on the next request and pushes the new pair, so dropping the old token frames from replay is low risk. Option B removes even that risk.

### 3.2 Compress the SSE stream
- **What.** Let `compression` cover `/api/events` and flush after each event. The `compression` README says the module "does not work out of the box with server-sent events" because it buffers a window. You must call `res.flush()` "when you need the data written to actually make it to the client" ([expressjs/compression README](https://github.com/expressjs/compression#server-sent-events)).
- **Where.** `server.ts:117-121`: remove the filter. In `broadcast.ts` `send()` (`:109-114`), the keep-alive (`server.ts:168-170`) and after `flushHeaders`, call `(res as any).flush?.()` after each write. For the replay, flush **once after the whole replay loop**, not after every entry, so the compressor sees the whole history as one window.
- **Win.** About 6-8x fewer bytes on the wire for the replay (measured ratios above). This is most useful while the replay is still big. After 3.1 it matters less but still helps.
- **Caveats.**
  - Per-event flushes compress worse than one big buffer, but the deflate dictionary carries over across sync flushes.
  - The WHATWG spec warns that chunking done by "a different layer unaware of the timing requirements" can hurt SSE reliability ([WHATWG](https://html.spec.whatwg.org/multipage/server-sent-events.html)).
  - Railway's own SSE guidance suggests `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` to stop edge buffering ([Railway SSE vs WebSockets](https://docs.railway.com/guides/sse-vs-websockets.md)).
  - Test on Railway that live events still arrive promptly.

### 3.3 Resume across reloads: client-side log cache + `?since=` cursor
- **What.** Keep the rendered log lines in the browser and ask the server only for what is newer. A new `EventSource` can't send `Last-Event-ID` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/EventSource/EventSource)), so pass the cursor in the URL. The server already treats ids as a resumable cursor that survives restarts (`broadcast.ts:72-81`).
- **Where.**
  - `server.ts:163-167`: use `req.headers['last-event-id'] ?? req.query.since`.
  - `index.html`: in `connect()`, append `&since=<lastSeq>`.
  - Persist `{seq, ts, level, task, message}` per rendered line. Use **IndexedDB**, which is async and has a large quota ([MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API), [quotas](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)). Avoid localStorage: it is synchronous, capped at 5 MiB, and already holds the datasets. Key the store by userId.
  - Render the cached lines first. That is the instant paint after a reload. Then append the delta.
  - `e.lastEventId` gives the seq of each live frame.
  - `clearLog()` (`:2301-2305`) must also clear the cache. `server:restarted` needs no special case.
- **Win.** After a reload, the server sends only the lines produced since the last visit, often zero. The visible log comes from local storage in milliseconds.
- **Cost.** Medium: about 60-100 lines of client code.
- **Caveats.**
  - Cache only *log lines*, not raw events. That way old events don't fire `handleMessage` side effects again, which also fixes the problem in 3.5.
  - The cursor must be the server `seq`, not `ts`.
  - If the client's `since` is older than the oldest in-memory entry (pushed out by the 2000 cap), the server should say so, for example with a `log:gap` frame, so the client can drop its cache or fetch history over HTTP (3.4).
  - Clearing the log on another device leaves a stale local cache. A `log:cleared` frame or a "generation" id fixes that.

### 3.4 Serve history over a normal HTTP endpoint (compressed, cacheable, paginated), and use SSE only for live
- **What.** `GET /api/logs?before=<seq>&limit=500` returns log lines (not raw events) as compact JSON. SSE then starts at `since=<newest seq from that response>`.
- **HTTP semantics that help:**
  - Compression applies automatically (the route is not filtered).
  - Express adds a weak `ETag` to `res.send`/`res.json` by default ([Express app settings](https://expressjs.com/en/5x/api/application/)), and conditional requests with `If-None-Match` → `304` ([RFC 9110 §13.1.2](https://www.rfc-editor.org/rfc/rfc9110#section-13.1.2), [§15.4.5](https://www.rfc-editor.org/rfc/rfc9110#section-15.4.5)) avoid re-sending an unchanged page.
  - A *closed* page (`before=<seq>`) never changes, so it can be `Cache-Control: private, max-age=31536000, immutable` ([RFC 9111 §5.2.2.1](https://www.rfc-editor.org/rfc/rfc9111#section-5.2.2.1), [§5.2.2.7](https://www.rfc-editor.org/rfc/rfc9111#section-5.2.2.7); immutable: [RFC 8246](https://www.rfc-editor.org/rfc/rfc8246)). The newest page must be `no-cache` so it is revalidated ([RFC 9111 §5.2.2.4](https://www.rfc-editor.org/rfc/rfc9111#section-5.2.2.4)).
- **Where.** A new route in `server.ts` next to `/api/logs/export`. A `broadcaster.page(userId, beforeSeq, limit)` method. Client: a "Load earlier" button at the top of `#logPanel`.
- **Win.** The first paint needs only the newest ~200-500 lines. Older history loads on demand.
- **Cost.** Medium.
- **Caveats.**
  - Routes under `/api` authenticate with `Authorization` (Bearer). Browsers don't share cached authenticated responses unless they are marked `private` or `public`. `private` is the right choice for the browser's own cache.
  - Express computes the ETag from the body, so a 304 saves bandwidth, not server work. That's fine here, because the in-memory slice is cheap.
  - This overlaps with 3.3. Do 3.3 *or* 3.4 as the main delta mechanism, not both at first.

### 3.5 Make replay side-effect free
- **What.** Don't run `loadArtists`, `loadAiPicks` or `loadStats` (and similar) for replayed events. Startup already calls them once (`index.html:3247-3252`).
- **Where.** `handleMessage` (`index.html:1270+`). Mark frames as replayed: the server can set a `replay: true` flag in `addClient`, or the client can treat any event whose `ts` is older than connect time as history. Skip the loaders when the flag is set.
- **Win.** It removes N×(2-3) needless API calls per refresh, and the main-thread work that comes with them.
- **Cost.** Small.

### 3.6 Render efficiently: batch, defer the scroll, cap the DOM
- **What and where (`log()`, `index.html:2229-2261`):**
  - During replay, build the entries into a `DocumentFragment` and insert it once. Set `scrollTop` once per animation frame (`requestAnimationFrame`) instead of once per line. This removes the write→read layout thrash ([web.dev](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing)).
  - Create two `Intl.DateTimeFormat` objects once and reuse them ([MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/toLocaleTimeString)).
  - Track the filter options in a `Set` instead of `[...select.options].some`.
  - Escape with `textContent` on a span instead of `esc()` creating a `div` each time.
  - Cap the panel at, say, the last 1000 nodes, and put the rest behind "Load earlier" (3.4).
  - Add `.log-entry { content-visibility: auto; contain-intrinsic-size: auto 1.6em; }` so the browser skips off-screen layout and paint ([MDN content-visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility)). It has been Baseline since September 2024.
- **Win.** Large for long logs: on the order of one layout per frame instead of one per line. This is independent of the network fixes.
- **Cost.** Small to medium.
- **Caveats.** The insert-by-timestamp walk (`:2245-2252`) still has to work with batched inserts. Sort the batch and merge it once.
- **Virtualisation** (render only the visible rows) is the heavier version. With a 280 px panel and a capped node count plus `content-visibility`, it probably isn't needed.

### 3.7 Break the startup waterfall
- **What.** Start `connect()` at the same time as `checkAuth()` instead of after `syncDataFromServer()`.
- **Where.** `index.html:3245-3247`. The stream ticket needs only the stored tokens. Cookie sessions don't need a ticket.
- **Win.** The log starts arriving one Spotify round trip plus one ~1.7 MB response earlier.
- **Cost.** Small.
- **Caveats.**
  - If the tokens are expired, `bearer-identity` refreshes them during the ticket request. That race already exists in today's flow.
  - The mobile `auth_token` exchange (`:1735-1744`) must still finish first.
  - `/api/export-data` is itself a candidate for the same ETag/304 treatment as 3.4, but that is outside log scope.

### 3.8 SSR / embedding the log in HTML
- **What.** Render the log into `index.html` on the server.
- **Fit.** Poor. The page is a static file served by `express.static`, and there is no framework with SSR or streaming SSR. In Bearer mode the user is known only from localStorage tokens, which the browser doesn't send with the HTML navigation request. So the server can't tell whose log to embed: the code comments say "EventSource can't send the Bearer headers" (`index.html:1219-1220`). It would also make the HTML uncacheable and per-user. The bytes would still have to travel, and the DOM would still have to be built. The client cache (3.3) gives the same "log visible at first paint" effect without these problems.
- **Verdict.** Not recommended.

### 3.9 WebSockets instead of SSE
- **What.** Railway exempts WebSockets from its request timeouts ([Railway](https://docs.railway.com/guides/sse-vs-websockets.md)). SSE is cut at 15 min, and `EventSource` reconnects with `Last-Event-ID`, which already resumes correctly.
- **Verdict.** This changes nothing about refresh cost. Not worth it for this complaint.

### 3.10 Server-side storage format (line offsets, chunked files, in-memory parse cache)
- **What.** Redis `LRANGE` is O(S+N) ([redis.io LRANGE](https://redis.io/docs/latest/commands/lrange/)). Day-bucketed lists already make slicing cheap. The refresh path reads memory, not Redis.
- **Where it would matter.** Only if 3.4 later pages back beyond the 2000 in-memory entries. Then use `LRANGE key -N -1` on the right day keys instead of `0 -1` plus a filter.
- **Verdict.** No work needed for this complaint.

## 4. Recommendation (ranked) and order

1. **3.1 — remove `data:save` from replay history** (coalesce `tokens` if you prefer), and set `browserMirror: false` on `BATCH_CACHE`. This is the biggest win for the least code, and it is likely most of the "takes a lot of time".
2. **3.6 + 3.5 — fix client rendering and replay side effects.** Batch inserts, scroll once per frame, cache the `Intl.DateTimeFormat`, use `content-visibility`, cap the DOM, and skip loaders on replay.
3. **3.7 — start the stream at the same time as auth/export-data.** One small reorder.
4. **3.3 — IndexedDB log cache + `?since=` cursor**, so a reload paints from local data and downloads only the delta. This is the real answer to "fetch on every refresh".
5. **3.2 — compress `/api/events`** with `res.flush()`. Do this after 3.1, and check on Railway that live delivery isn't buffered.
6. **3.4 — paginated `/api/logs` with ETag and immutable closed pages.** Only if the capped DOM plus local cache still feels heavy, or if you want to scroll back through the full week in the UI.

Skip SSR (3.8), WebSockets (3.9) and storage reformatting (3.10) for this problem.

**How to verify.** Before and after each step, reload with DevTools open and record:
- the transferred size of `/api/events` until the replay finishes. To find where the replay ends, add a temporary `replay:done` frame after the loop in `addClient`.
- a Performance trace: look for "Forced reflow" warnings in `log()`.

Remember the stale-build caveat: run `rm -rf build` before trusting `npm test`.
