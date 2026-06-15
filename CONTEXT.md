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
The operation that builds weekly playlists for every unprocessed Friday — one week collection per date, plus the playlist writes.
_Avoid_: batch run, sync

**Week collection**:
The act and result of gathering one Friday's qualifying releases and their tracks: searching P1/P2 artists, merging editorial finds, choosing variants, applying popularity gates, excluding listening history. Produces releases, ordered tracks, and collection decisions.
_Avoid_: date pipeline, release collection (the old module name)

**Weekly playlist**:
A date-named (`DD.MM.YY`) Spotify playlist holding one Friday's week collection.

**Week progress**:
The resumable checkpoint of a partially-searched week, persisted so an aborted fill resumes mid-week instead of re-searching every artist.
_Avoid_: artist search progress

**Collection decision**:
A record of one choice made during week collection — variant picked, deluxe tracks stripped, title-track-only, single skipped as duplicate, low-popularity filtered. The audit trail the UI and logs render.

### Syncing

**Promotion sync**:
Reconciling already-published weekly playlists with a recalculation's priority changes — removing the tracks of artists demoted out of P1/P2, and backfilling in-window releases from artists promoted into P1/P2. Runs after recalculation, over unprocessed (non-listened) weekly playlists only. Shares the release-discovery and track-collection engine with week collection, but has no editorial merge, no checkpoints, and no Friday window of its own (it matches each playlist's own date). Returns its own collection decisions, removal included.
_Avoid_: playlist sync, priority diff, backfill

**Priority change**:
One artist crossing the P1/P2 boundary during recalculation — a *promotion* (into P1/P2) or a *demotion* (out of P1/P2). Only boundary crossings drive promotion sync; movement within or below the boundary does not.

**Album-unit removal**:
The rule that promotion sync removes a demoted artist's tracks an album at a time: a whole album stays if any of its tracks belongs to a P1/P2 artist (it was added for that feature), otherwise the demoted artist's album group is removed entirely.

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

**External playlist source**:
A pattern (user + name pattern + date format) for discovering another user's date-named playlists as editorial input for a given week.

## Flagged ambiguities

- **"Weekly"** is overloaded: *All Weekly* is the listening-history source; a *weekly playlist* is an output. Never shorten either to just "weekly".
- **"Fill" vs "week collection"**: fill is the multi-week operation; week collection is one Friday's gathering. The code historically blurred these inside `date-pipeline.ts`.

## Example dialogue

> **Dev:** The fill stopped halfway through last Friday — do we re-search all 400 artists?
> **Expert:** No, week progress checkpoints during the week collection. The next fill resumes from the last checkpoint.
> **Dev:** And the deluxe edition of an album we already added in March?
> **Expert:** Deluxe release — only the bonus tracks qualify. The base album's tracks are already in the listening history anyway, so they'd be excluded twice over. Check the collection decisions if you want to see which tracks were stripped and why.
> **Dev:** An editorial playlist had an artist we never listen to.
> **Expert:** Then they're not in the trusted artists, so the popularity and genre gates decide. If they passed, the release joins the week collection like any P1 find.
