import type {
  Candidate,
  CandidateProvenance,
  TasteContext,
  TasteJudgeRequest,
} from '../week-collection/index.js';

// Renders the structured taste context and candidate pool into prompt text.
// Only the Claude TasteJudge does this (ADR-0005). Started from the AI-pick
// prototype's v2 prompt (roster-first, relative popularity), extended with
// the merged `sources` column and popularity against the week's releases;
// tune it against the eval script.

export interface TastePrompt {
  /** Instructions, roster slice and accept list: the same for every week of a fill. */
  stable: string;
  /** The week's collection, then the pool. */
  week: string;
}

export function renderTastePrompt(request: TasteJudgeRequest): TastePrompt {
  return {
    stable: renderStable(request.taste),
    week: renderWeek(request.taste, request.candidates),
  };
}

const INSTRUCTIONS = `You pick new releases for one listener's weekly playlist.

The listener already gets every release this week by their core artists (P1/P2). From a pool of this week's other releases, find the ones they'd also want. Each candidate's "sources" says how it got into the pool, and a candidate can have several:
- "roster": an artist already in the listener's own listening history, below the core tiers (P3, P4, or unranked). This is the strongest evidence you have: the listener has chosen to play this artist before. A P3 artist's new release is usually wanted; P4 and unranked less so.
- "related to": an artist Deezer considers similar to the named core artists. The listener has never played this artist. Only pick one when the fit is tight (related to several core artists in one clear scene) and the release has real weight.
- "in": the release is on a playlist the listener follows for discovery. Being seen there is evidence the release sits in their scenes, not a verdict.
- "editorial reject" / "popularity-gate reject": an editorial playlist the listener follows carried the release, but a popularity or follower gate turned it away. The playlist counts in its favour; the gate's reason says how small it is.

Weigh how big the release is, two ways:
- "popularity" is the release's best Deezer track on a 0–100 scale, the same one shown for the releases already in this week's playlist. Compare it with them: those are what this week's listening sounds like. A candidate far below them is a small release however well it fits, and one from an artist the listener has never played (only "related to") rarely deserves a pick. A release near or above them has real weight.
- "vs usual" compares that best track with the artist's own usual top tracks: around 1x or above is one of their bigger releases, well below 0.2x is a minor one (a remix, a filler single). An artist whose usual is itself small or long past its peak can reach 1x with a release few people play, so read it next to "popularity", never alone.
Both are evidence, not gates: a modest release by a P3 roster artist can still be wanted.

Score each candidate's chance the listener wants it, using the whole scale: 85+ = clearly wants it, 65 = probably, 50 = coin flip, 30 = probably not. Return every candidate you score 30 or more, with its id, the confidence, and a reason of at most 20 words that says why this listener specifically would want it (their history with the artist, which core artists it sits beside, how big the release is). Leave out candidates below 30.`;

function renderStable(taste: TasteContext): string {
  return `${INSTRUCTIONS}

## Listener's artists (by tier, strongest first)
P1 = favourite, P2 = core, P3/P4 = listened to less, unranked = barely.
${taste.roster.map((a) => `${a.name} [${a.tier}]`).join('\n')}

## Genres the listener prefers
${taste.acceptGenres.join(', ')}`;
}

function renderWeek(taste: TasteContext, candidates: Candidate[]): string {
  const collected = taste.weekReleases.map(
    (r) => `${r.artist} – ${r.release} (popularity ${r.popularity ?? '?'})`,
  );
  return `## Already in this week's playlist
${collected.join('\n') || '(nothing)'}

## Candidates
id | artist | title | type | tracks | date | Deezer genres | artist fans | popularity | vs usual | sources
${candidates.map(candidateRow).join('\n')}`;
}

function candidateRow(c: Candidate): string {
  return [
    c.id,
    c.artist,
    c.title,
    c.type,
    c.trackCount,
    c.releaseDate,
    c.genres.join('/') || '-',
    c.artistFans ?? '?',
    c.popularity ?? '?',
    c.relativePopularity === null
      ? '?'
      : `${c.relativePopularity.toFixed(1)}x artist's usual`,
    sources(c.provenance),
  ].join(' | ');
}

/** Every source once; the scouting playlists as one `in A, B`. */
function sources(provenance: CandidateProvenance[]): string {
  const scouting = provenance.flatMap((p) =>
    p.kind === 'scouting' ? [p.playlist] : [],
  );
  return [
    ...provenance.filter((p) => p.kind !== 'scouting').map(sourceLabel),
    ...(scouting.length ? [`in ${scouting.join(', ')}`] : []),
  ].join('; ');
}

/** Most related seeds named before the rest are counted. */
const SEEDS_SHOWN = 4;

function sourceLabel(
  p: Exclude<CandidateProvenance, { kind: 'scouting' }>,
): string {
  switch (p.kind) {
    case 'related': {
      const more = p.to.length - SEEDS_SHOWN;
      const shown = p.to.slice(0, SEEDS_SHOWN).join(', ');
      return `related to ${shown}${more > 0 ? ` +${more}` : ''}`;
    }
    case 'roster':
      return `roster ${p.priority ? `P${p.priority}` : 'unranked'}`;
    case 'editorial-reject':
      return `editorial reject (${p.reason})${playlists(p.playlists)}`;
    case 'low-popularity':
      return `popularity-gate reject (popularity ${p.popularity})${playlists(p.playlists)}`;
  }
}

const playlists = (names: string[]) =>
  names.length ? ` from ${names.join(', ')}` : '';
