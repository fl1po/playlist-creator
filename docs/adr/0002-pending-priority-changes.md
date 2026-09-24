# Promotion sync is deferred through durable pending priority changes

Recalculation ran in three places with three orderings. The standalone task synced and then persisted (so a failed sync blocked the save and the run could be retried). Mid-fill persisted immediately and synced at the end of the fill, which lost the priority changes whenever the fill aborted or the sync failed: the new roster was already saved, and the "before" priorities existed only in memory. The CLI never synced. We made one Recalculation module (`services/recalculation/`) with two operations. `recalculate` saves the roster together with the **pending priority changes**: the P1/P2 crossings not yet applied, merged per artist so a promotion undone before a sync nets out. `syncPending` is the only path from recalculation to promotion sync, and it clears the record only after the sync succeeds. Durability comes from that record, not from ordering: an abort or a sync failure defers the sync to the next recalculation or fill, and promotion sync is safe to replay (removal re-reads playlists, and backfill skips tracks already present).

## Considered options

- **Always sync before persisting, everywhere** (the standalone task's old rule, extended to mid-fill): rejected because it gives up the fill's single trailing sync (CONTEXT.md). Every mid-fill recalculation would sync on its own. It also still loses the changes if the process dies between sync and save.
- **One `recalculate` operation with a `sync: 'now' | 'defer'` flag**: rejected for the same reason ADR-0001 rejected mode flags on `collectWeek`. It gives sync two entry points, and the fill would still need a separate trailing-sync trigger.
- **Treating a failed sync as fatal to the recalculation** (the old "sync must propagate so persistence is blocked" rule): no longer needed. With pending changes stored, the roster can be saved regardless, and a failed sync just stays pending.

## Consequences

- Recalculation state (source snapshots and reusable scans) moved out of `BatchCache` into its own `RECALCULATION_STATE` descriptor, so the fill and recalculation each own exactly one piece of durable state. Older `batch-cache.json` files are read once as a migration.
- A cold cache always recalculates, including mid-fill. The fill alone decides not to re-score half-way through a week's artist search.
- A first-ever recalculation (no prior roster) is a baseline. It records no pending changes, so it never backfills the whole roster into existing playlists.
