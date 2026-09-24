/**
 * Genre clustering and era mapping for year collection.
 *
 * Two jobs, both derived from the roster's actual Spotify genre vocabulary
 * (370 distinct genres across 1,797 tagged artists):
 *
 * 1. `clusterOf` assigns a genre to one of ~13 scenes. Acclaim is normalized
 *    to a percentile *within* a cluster so grime competes with grime rather
 *    than with mainstream rap — see acclaim.ts.
 *
 * 2. `ancestorsOf` maps a post-2016 micro-genre back to the scenes it grew
 *    out of. This is meant as a *fallback*, not a rewrite: measure how many
 *    releases each profile genre actually yields for the target year and
 *    consult this table only for genres that come up starved, which keeps the
 *    mapping honest for years where a genre did exist. Not yet wired into
 *    `collectYear` — nothing calls `ancestorsOf` today.
 */

export type Cluster =
  | 'afro'
  | 'grime'
  | 'drill'
  | 'rnb-soul'
  | 'uk-bass'
  | 'club'
  | 'caribbean'
  | 'us-rap'
  | 'jazz'
  | 'electronic'
  | 'art-pop'
  | 'regional'
  /** Genres outside the profile entirely — rock, country, metal, classical. */
  | 'other'
  /**
   * No genre signal at all. Distinct from 'other' on purpose: roughly 47% of
   * the roster carries no Spotify tags, and pooling those with rejected
   * genres would percentile-rank a rap record against a country record.
   */
  | 'unknown';

/**
 * Genres whose cluster the ordered rules below would get wrong.
 * Checked first, exact match on the lowercased genre.
 */
const CLUSTER_OVERRIDES: Record<string, Cluster> = {
  // Jazz subgenres that the r&b/soul rule would otherwise swallow.
  'soul jazz': 'jazz',
  'jazz funk': 'jazz',
  // Rap subgenres that read as another scene on keywords alone.
  'jazz rap': 'us-rap',
  'trap metal': 'us-rap',
  'rap metal': 'us-rap',
  'rap rock': 'us-rap',
  'christian hip hop': 'us-rap',
  'g-funk': 'us-rap',
  // Scene membership beats keyword: these are Afro scenes, not UK/US ones.
  'nigerian drill': 'afro',
  'ghanaian hip hop': 'afro',
  // UK R&B is the London scene, not a regional-language bucket.
  'uk r&b': 'rnb-soul',
  // "lo-fi" and "trap" as modifiers, not scene markers.
  'lo-fi house': 'electronic',
  'lo-fi indie': 'art-pop',
  'edm trap': 'electronic',
  'melodic bass': 'electronic',
};

/**
 * Ordered cluster rules. First match wins, so order encodes precedence:
 * Afro before drill (nigerian drill), r&b before rap (alternative r&b,
 * trap soul), rap before jazz (jazz rap), everything before art-pop.
 */
const CLUSTER_RULES: Array<[Cluster, RegExp]> = [
  // `alt[ée]` cannot use \b — JS word boundaries are ASCII-only, so there is
  // no boundary after "é" and /alté\b/ never matches.
  [
    'afro',
    /\bafro(?!disiac)|alt[ée](?![a-z])|amapiano|azonto|hiplife|gqom|highlife|asakaa|f[úu]j[ìi]|kwaito|bacardi|private school piano|kizomba|kuduro|\bbongo\b|gengetone|singeli|ndombolo|rumba congolaise|coup[ée] d[ée]cal[ée]|maskandi|mahraganat|gnawa|shaabi/,
  ],
  ['grime', /\bgrime\b/],
  ['drill', /\bdrill\b/],
  // Caribbean before regional so kompa/zouk/calypso do not fall to language.
  [
    'caribbean',
    /dancehall|reggae|ragga|soca|\bdub\b|lovers rock|shatta|kompa|zouk|calypso|rocksteady|dembow/,
  ],
  [
    'regional',
    /\bfrench\b|\bgerman\b|brazilian|carioca|brega|\bk-pop\b|\bk-rap\b|\bk-ballad\b|\bj-rap\b|\bj-r&b\b|\bj-rock\b|latin|reggaeton|neoperreo|urbano|italian|mexican|indonesian|moroccan|ivoire|pop urbaine|argentine|chinese|\bc-pop\b|desi|portuguese|arabic|malayalam|punjabi|thai|\bt-pop\b|turkish|egyptian|pinoy|tamil|telugu|taiwanese|mandopop|swedish|malay|afrikaans|corrido|banda|m[úu]sica mexicana|sierre[ñn]o|cumbia|chanson|qu[ée]b[ée]coise|visual kei|bhangra|tollywood|kollywood|khaleeji|new mpb|pagode|samba|techengue/,
  ],
  [
    'rnb-soul',
    /r&b|\bsoul\b|quiet storm|new jack swing|\bfunk\b|boogie|motown|go-go/,
  ],
  [
    'uk-bass',
    /garage|bassline|drum and bass|jungle|liquid funk|dubstep|riddim|3 step|uk funky|breakbeat|bass music|future bass|drumstep|deathstep|chillstep/,
  ],
  ['club', /jersey club|ballroom|baltimore club|footwork|philly club/],
  [
    'us-rap',
    /hip hop|\brap\b|boom bap|\btrap\b|hyphy|crunk|horrorcore|bounce|miami bass|phonk|cloud rap|lo-fi|spoken word/,
  ],
  ['jazz', /jazz|trip hop/],
  [
    'electronic',
    /house|\bedm\b|techno|trance|disco|\bidm\b|glitch|moombahton|electro|big room|\brave\b|big beat|downtempo|eurodance|europop|synthpop|vaporwave|ambient|\bdrone\b|dance\b/,
  ],
  [
    'art-pop',
    /\bpop\b|indie|chillwave|hyperpop|plunderphonics|psychedelic|experimental|slowcore|shoegaze|dream/,
  ],
];

/** Assign a Spotify genre string to a scene cluster. */
export function clusterOf(genre: string): Cluster {
  const g = genre.toLowerCase().trim();
  const override = CLUSTER_OVERRIDES[g];
  if (override) return override;
  for (const [cluster, pattern] of CLUSTER_RULES) {
    if (pattern.test(g)) return cluster;
  }
  return 'other';
}

/**
 * Post-2016 micro-genres → the scenes they descend from.
 *
 * Consulted only when a genre is measured to starve in the target year.
 * Each entry names music that actually existed then and that the modern
 * genre grew out of, so a taste dimension survives in era-appropriate form
 * instead of silently contributing nothing.
 */
const ANCESTORS: Record<string, string[]> = {
  // UK drill coalesced in Brixton ~2016-17 off Chicago drill and road rap.
  'uk drill': ['road rap', 'grime', 'uk hip hop'],
  'brooklyn drill': ['chicago drill', 'east coast hip hop'],
  'new york drill': ['east coast hip hop'],
  'sexy drill': ['drill', 'east coast hip hop'],
  'aussie drill': ['drill'],
  'nigerian drill': ['afrobeats', 'hiplife'],

  // Afroswing is a 2017-19 UK hybrid of afrobeats, funky and dancehall.
  afroswing: ['afrobeats', 'uk funky', 'dancehall'],
  // Alté emerged in Lagos ~2017 as an alternative to mainstream afrobeats.
  alté: ['afrobeats', 'alternative r&b'],
  'afro adura': ['afrobeats', 'afro gospel'],
  asakaa: ['hiplife', 'ghanaian hip hop'],

  // The piano family is all 2019+; its roots are South African house.
  afropiano: ['afrobeats', 'afro house', 'kwaito'],
  amapiano: ['afro house', 'kwaito', 'gqom'],
  'private school piano': ['afro house', 'kwaito'],
  'afro tech': ['afro house', 'tech house'],

  // 3 step is a 2023 revival of the UK garage lineage.
  '3 step': ['uk garage', '2-step garage'],
  'stutter house': ['house', 'uk garage'],

  // Rage and hyperpop are both ~2019-20.
  'rage rap': ['cloud rap', 'trap'],
  hyperpop: ['art pop', 'bedroom pop', 'electronic'],
  'drift phonk': ['phonk', 'memphis rap'],
};

/**
 * Era ancestors for a genre, or an empty array when the genre has none
 * registered. Callers apply this only to genres measured as starved.
 */
export function ancestorsOf(genre: string): string[] {
  return ANCESTORS[genre.toLowerCase().trim()] ?? [];
}

/** Every genre with a registered ancestor mapping — for reporting. */
export function mappedGenres(): string[] {
  return Object.keys(ANCESTORS);
}
