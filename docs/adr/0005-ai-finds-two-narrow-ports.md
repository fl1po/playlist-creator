# AI finds enter week collection as a phase behind two narrow ports

ADR-0001 rejected a pluggable `ReleaseSource` port "until a third release source actually materializes". AI finds are that third source: Claude picks releases from a deterministic **candidate pool** of this week's releases by artists the P1/P2 search doesn't cover. We put them **inside `collectWeek`** as a phase between the editorial merge and the popularity gate, behind two new narrow ports. The first is `CandidateSource` (Deezer). It returns the week's in-window releases by related artists of P1/P2 seeds and by P3/P4 and unranked roster artists, and it owns the cached related-artist graph. The second is `TasteJudge` (Claude). It takes structured taste and candidates and returns picks, and it owns the prompt and the SDK. Editorial-gate and low-popularity rejects of non-roster artists are kept with their ids and join the pool. Assembling the pool and applying the pre-filters are pure steps inside the module (`week-collection/ai-finds.ts`). Picks become ordinary `FoundRelease`s, so they go through the same variant strip, `collectTracks` (deluxe, title-track-only, history) and ordering as every other release.

The order of operations is fixed. Before the judge: the window check, dedup against the week's found releases, the genre reject veto and variant collapse. After it: one Spotify search by barcode (`ReleaseReads.searchByUpc`) per pick, never per candidate, then the track rules. AI finds skip the popularity gate, because the LLM's confidence replaces it, and they're ordered after the popularity-ranked releases, by confidence.

## Considered options

- **A separate step in `fill-run` after `collectWeek`**: rejected. The rejects, the shape rules and the play order all live inside `collectWeek`. A post-step would need its own copy of the dedup, a second `collectTracks` pass, its own merge of the play order and its own checkpointing, and the shape rules would drift between the two copies.
- **One deep `AiFinder` port hiding the pool, the graph and the LLM**: rejected. The pool is deterministic and testable with fixtures, and the judge is the narrow LLM seam later AI features should reuse. One port would bury both.
- **A generic `ReleaseSource` port with artist search and editorial as adapters**: still rejected. Those two stay hardwired. Only the new source gets ports, because only it has a second adapter (fixtures) and an external dependency worth swapping.
- **Resolve every candidate to Spotify before judging**: rejected. That's about 100+ extra Spotify requests a week against the shared 1 req/s budget (ADR-0003/0004), when the picks are only a fraction of them.

## Consequences

- The cost ceiling spans the fill, but `collectWeek` stays stateless. The input carries the remaining budget, and the result returns `aiSpendUsd` and `aiExhausted`. `fill-run` carries the remainder from week to week. The ceiling bounds the *next* call, so one week's call can overshoot it.
- Never fatal: only abort and `SpotifyAuthLost` escape the AI phase. Every other failure becomes an `ai-skipped` collection decision and the week completes. `TasteJudge` reports failures as typed outcomes, so Anthropic SDK error classes never cross the seam.
- `CollectionDecision` gains `ai-pick` and `ai-skipped`. `low-popularity` rejects keep their album id.
- P3/P4 roster artists are never searched on Spotify. Deezer decides whether they released anything this week.
- Production adapters live in `services/ai-finds/` and are wired through `FillPorts`. Tests use fixture adapters for both ports.
