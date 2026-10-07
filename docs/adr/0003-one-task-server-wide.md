# One task runs at a time across the whole server

The web app runs at most one task (fill, recalculation, clear, dedup…) at a time across all users, not one per user. Every task's Spotify calls go through one shared request pacer, because the Spotify app's rate limit is shared by every user of the app. Two users filling at once would just halve each other's throughput and make a rate-limit sleep more likely, and a hit then stalls both. The user who started the task owns it. Only they can stop it or see which task is running. Everyone else sees the server as busy, so a second user's start gets a "busy" refusal instead of queueing.

## Considered options

- **One task per user**: rejected while the pacer is shared. It only pays off together with a per-user pacer, which is a rate-limit redesign, not a task-runner change. Revisit that first if concurrent users become common.
- **Clear outside the lock** (how it used to work, synchronous inside the request): rejected because a clear could empty a weekly playlist while a fill was writing to it, and it still competed for the shared pacer. Clear is now an ordinary task.
