# Playlists Creator

Automated weekly Spotify playlist generation driven by the user's listening history. New releases from artists the user actually listens to land in date-named playlists every Friday.

## Language

### Scoring

**Recalculation**:
Re-scoring every artist found in the source playlists to produce the trusted artists roster.
_Avoid_: priority update, rescan

**All Weekly (AW)**:
The source playlist logging everything the user listens to. Primary scoring signal, and the listening history used for dedup.
_Avoid_: history playlist

**Best of All Weekly (BoAW)**:
The secondary scoring signal — a favourites playlist, or Liked Songs when configured.

**Priority (P1–P4)**:
An artist's tier derived from listening score. Only P1/P2 artists are searched during week collection. Null priority means below threshold.
_Avoid_: rank, tier

**Trusted artists**:
The scored artist roster produced by recalculation (`trusted-artists.json`). Source of truth for who qualifies.

### Filling

**Fill**:
The operation that builds weekly playlists for every unfilled Friday — one week collection per date, plus the playlist writes. Always ends with a promotion sync if any of the fill's own mid-fill recalculations crossed a P1/P2 boundary; a fill isn't finished until that trailing sync has run, regardless of whether it was started from the CLI or the web UI.
_Avoid_: batch run, sync

**Week collection**:
The act and result of gathering one Friday's qualifying releases and their tracks: searching P1/P2 artists, merging editorial finds, choosing variants, applying popularity gates, excluding listening history. Produces releases, ordered tracks, and collection decisions.
_Avoid_: date pipeline, release collection (the old module name)

**Weekly playlist**:
A date-named (`DD.MM.YY`) Spotify playlist holding one Friday's week collection. It is *filled* once it holds tracks; an empty one is reused by the next fill, never recreated.

**Unfilled Friday**:
A Friday since the earliest weekly playlist (or the default start) that has no filled weekly playlist yet. What a fill iterates over.
_Avoid_: unprocessed Friday, missing date

**Week progress**:
The resumable checkpoint of a partially-searched week, persisted so an aborted fill resumes mid-week instead of re-searching every artist.
_Avoid_: artist search progress

**Collection decision**:
A record of one choice made during week collection — variant picked, deluxe tracks stripped, title-track-only, single skipped as duplicate, low-popularity filtered. The audit trail the UI and logs render. A release counts as *found* only once it lands — adds at least one track to the weekly playlist. A release discovered but then filtered out, or whose tracks were all already there, records only the decision that dropped it. The task log says *discovered* when the search turns a release up and *added* once it is found, never "found" for a release that may still be dropped.

**Release qualification**:
The shared rules that decide which of a set of found releases, and which of their tracks, qualify for a weekly playlist: the popularity gate, the variant strip, the deluxe and title-track-only rules, and listening-history exclusion. Week collection and promotion sync both run their releases through it, so a collection decision means the same thing in either.
_Avoid_: release collection (the old module name), engine

### Syncing

**Promotion sync**:
Reconciling already-published weekly playlists with a recalculation's priority changes — removing the tracks of artists demoted out of P1/P2, and backfilling in-window releases from artists promoted into P1/P2. Runs after recalculation, over unprocessed (non-listened) weekly playlists only — whether that recalculation happened standalone or mid-fill. Shares release discovery and release qualification with week collection, but has no editorial merge, no checkpoints, and no Friday window of its own (it matches each playlist's own date). Never produces AI finds, and treats an existing AI find like any other track: backfill skips it by track, and album-unit removal can remove it. Returns its own collection decisions, removal included.
_Avoid_: playlist sync, priority diff, backfill

**Priority change**:
One artist crossing the P1/P2 boundary during recalculation — a *promotion* (into P1/P2) or a *demotion* (out of P1/P2). Only boundary crossings drive promotion sync; movement within or below the boundary does not.

**Pending priority changes**:
The durable record of priority changes that promotion sync hasn't applied yet. Saved together with the recalculated roster and cleared only once promotion sync succeeds, so an abort or a sync failure defers the sync instead of losing it — the next recalculation or fill finishes it. Changes to the same artist accumulate and net out (promoted then demoted before a sync is no change).
_Avoid_: sync queue, outbox

**Album-unit removal**:
The rule that promotion sync removes a demoted artist's tracks an album at a time: a whole album stays if any of its tracks belongs to a P1/P2 artist (it was added for that feature), otherwise the demoted artist's album group is removed entirely.

### Running

**Task**:
One user-started background operation in the web app — a fill, recalculation, clear, dedup scan, and so on. At most one runs at a time across the whole server. The user who started it *owns* it: only they can stop it or see which task is running; everyone else just sees the server as busy. Its progress is held by the server and shown only to its owner; it isn't part of the log, so nothing of it survives the task's end. Its log lines carry the task's name, which is what the live log's process filter shows.
_Avoid_: job, process (except as the live log's label)

**Task log**:
The lines a task writes, worded once on the server from what the task did, and the same in the CLI, the live log panel and the export. A task's results — what the page reloads or draws from — travel beside it as data, never as text for the page to word.
_Avoid_: event log, messages

### Releases

**Release**:
An album, single, or compilation by an artist with a release date inside the week's date window.

**Variant**:
An alternate edition of the same release — explicit/clean, instrumental, acoustic, sped-up/slowed, regional duplicates. A week collection keeps exactly one variant: prefer explicit, then widest market coverage; never keep instrumental/sped/slowed when an original exists.
_Avoid_: duplicate, version

**Deluxe release**:
An extended reissue of an existing album. Only the tracks absent from the base album qualify for the week collection.

**Title-track-only**:
A release that is really single promotion — more than half of its non-title tracks are old. Only the title track qualifies.

**Editorial playlist**:
A hand-curated source of releases. Artists unknown to the trusted roster must pass popularity/follower and genre gates to qualify.

**AI find**:
A release from the week's date window, by an artist the P1/P2 search doesn't cover (outside the trusted roster, or below P1/P2 in it), chosen by an LLM from a candidate pool because it fits the user's taste. Joins the weekly playlist alongside artist-search and editorial releases; how many land is decided by the LLM's confidence, not a fixed count.
_Avoid_: discovery (clashes with release discovery), recommendation

**Candidate pool**:
The deterministic set of a week's in-window releases by artists not searched as P1/P2 — related artists of P1/P2, lower-priority roster artists, editorial-gate rejects, and releases in scouting playlists — that the LLM judges for AI finds. Each candidate keeps every source it came from. The LLM chooses from it and never invents releases.
_Avoid_: shortlist, suggestions

**Related-artist graph**:
The artists Deezer considers related to each P1/P2 artist, kept per P1/P2 artist and refreshed when it goes stale. The related artists named by at least two current P1/P2 artists feed the candidate pool. The graph doesn't depend on the week, and a change in who is P1/P2 changes which part of it is read, not the graph itself.
_Avoid_: similar artists, neighbours

**Relative popularity**:
How a release is doing against its own artist's usual tracks, rather than against everyone's. It separates an artist's weak side release from their real one, and it doesn't penalise small artists the way a fan count does. It decides which candidates survive when the candidate pool is too big.
_Avoid_: popularity (that's the absolute Spotify/Deezer figure the editorial gate uses)

**Taste context**:
What the LLM judges the candidate pool against: the P1/P2 artists plus the highest-scoring slice of the rest of the trusted roster, each labelled with its priority; the user's accepted genres as a soft preference; and the week's own P1/P2 releases, as "what you're already getting". Names and tiers only, with no scores or genre vectors.
_Avoid_: taste profile (that's year collection's genre vector), user profile

**AI pick**:
The collection decision recording an AI find — the release chosen and the LLM's one-line reason. Also covers the week's AI finds being skipped when the user has opted in but the AI phase couldn't run (no API key, over budget, failed). A user who hasn't opted in gets no AI pick at all. Unlike other collection decisions, a week's AI picks are kept with its weekly playlist, so the user can see after the fill why each AI find is there.

**External playlist source**:
A pattern (user + name pattern + date format) for discovering another user's date-named playlists as editorial input for a given week.

**Scouting playlist**:
A playlist the user follows for discovery, read only when AI finds are on. Its releases enter the candidate pool and tell the LLM where they were seen, but never join the weekly playlist directly — unlike an editorial playlist, nothing passes a gate to qualify.
_Avoid_: signal playlist, discovery playlist

## Flagged ambiguities

- **"Weekly"** is overloaded: *All Weekly* is the listening-history source; a *weekly playlist* is an output. Never shorten either to just "weekly".
- **"Fill" vs "week collection"**: fill is the multi-week operation; week collection is one Friday's gathering. The code historically blurred these inside `date-pipeline.ts`.
- **"Taste"** is overloaded: year collection's *taste profile* is a genre/cluster vector; AI finds' *taste context* is a tiered list of artist names. Always say which.
- **"Unprocessed"** belongs to promotion sync: an *unprocessed weekly playlist* is published but not yet listened to. A Friday the fill still has to build is an *unfilled Friday*, never "unprocessed".

## Example dialogue

> **Dev:** The fill stopped halfway through last Friday — do we re-search all 400 artists?
> **Expert:** No, week progress checkpoints during the week collection. The next fill resumes from the last checkpoint.
> **Dev:** And the deluxe edition of an album we already added in March?
> **Expert:** Deluxe release — only the bonus tracks qualify. The base album's tracks are already in the listening history anyway, so they'd be excluded twice over. Check the collection decisions if you want to see which tracks were stripped and why.
> **Dev:** An editorial playlist had an artist we never listen to.
> **Expert:** Then they're not in the trusted artists, so the popularity and genre gates decide. If they passed, the release joins the week collection like any P1 find.
