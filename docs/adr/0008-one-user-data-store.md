# User data lives in one store per user, its mode chosen once at the composition root

A user's datasets used to be reached through `createDurableCache({ userId, dataDir, redis?, onSave? })`, built afresh at 13 sites. Each caller knew the user's data dir. Any call that left out `redis` silently fell back to production Upstash whenever `UPSTASH_*` was set, so the unprocessed-playlists listing wrote to production Redis from a CLI recalculation that had passed `redis: null` for everything else. Config sat in a second store with its own Redis client and was Redis-only in production. The log store had a third client. The list of "a user's datasets" was written out by hand four times (`/api/export-data`, `/api/import-data`, `import-from-redis`, the page's `syncDataFromServer`), and no two lists matched. Every save was also mirrored into the browser's localStorage, where the page used it only as a fallback when a request failed.

We replaced all of it with one module, `lib/user-data/`: the **user data store** (CONTEXT.md). It holds every **dataset**, config included, and its interface is `load(dataset)`, `save(dataset, value)`, `delete(dataset)` and a typed `config` slice. It runs in one of two modes, chosen once at each composition root:
- **durable**: the file is read first, and Redis keeps the copy that survives an ephemeral disk.
- **local**: file only.

The web server reads `UPSTASH_*` once, builds one client, and gives it to both the store and the log store. It chooses durable mode when Upstash is configured and local mode otherwise. The CLI is always local, whatever the environment says. Nothing below the composition root reads `UPSTASH_*`. The only exception is `import-from-redis`, which reads production on purpose. Every session builds one store in `buildSession`, and tasks and services receive that store, never a data dir. The token stores keep their own per-user directory, because tokens are auth state on the gateway's side, not user data.

## Considered options

- **Typed slices per owner** (`store.recalculation.loadState()`, …): rejected. The store's interface would then change with every owner. ADR-0007 rejected the same shape for the task log. Ownership already shows in which module imports which dataset. The narrow seams that pay off (`FillStorage`, the recalculation ports, the Deezer `CandidateSource`) sit on top of the store.
- **Keep config Redis-only behind its own adapter**: rejected. It keeps a second client and a special case in `copy`. Config is now file-first like every other dataset, which is safe on the single Railway instance every dataset already assumes.
- **Dataset kinds** (record / progress / rebuildable, with only records copied): rejected. Copying production down is how real data reaches a local machine. A copy without the scans and Deezer lookups would re-pay those costs, and it would behave differently on a cold cache (ADR-0002). A dataset carries only its name, file and `isEmpty`.
- **Keep a browser mirror** (all datasets, or the three the page fell back to): rejected. The copies served only when the server failed to answer, and then the rest of the page was down too. They cost a ~1.7 MB `/api/export-data` on every load and a `data:save` per save. Only the bearer-mode token push still uses `data:save`.
- **The filesystem behind a port too**, so that tests don't need temp dirs: rejected. A temp dir is a faithful local stand-in. Redis is the only external seam, with two adapters: Upstash and in-memory.

## Consequences

- `copy(from, to)` over the catalogue is the one migration. `import-from-redis` copies a durable store over production into a local one. `migrate.html`, `/api/import-data`, `/api/export-data` and the legacy single-user migration in `server.ts` were deleted.
- The fill's per-run report (`batch-p1p2-progress.json`) was dropped. It was write-only, and the task log already says the same thing.
- The store's own suite pins the durable behaviour the deployment relies on: after a wiped disk the value loads from Redis, the file wins over Redis, and a Redis failure never fails a load or a save. Caller tests use a local store over a temp dir.
