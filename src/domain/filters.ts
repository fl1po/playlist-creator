// Genre filtering for non-trusted artists from editorial playlists

export const acceptedGenres = [
  "hip-hop", "rap", "r&b", "soul", "electronic", "house", "techno", "trap",
  "dancehall", "reggaeton", "latin", "afrobeat", "grime", "drill", "dance",
  "pop", "urban", "uk", "bass", "dubstep", "garage", "funky", "afrobeats",
  "reggae", "dub", "edm", "phonk",
];

export const rejectedGenres = [
  "rock", "folk", "indie folk", "classical", "post-punk", "emo", "country",
  "metal", "jazz", "blues",
];

export interface GenreFilterLists {
  accepted: string[];
  rejected: string[];
}

export function isGenreAcceptable(
  genres: string[] | undefined,
  lists?: GenreFilterLists,
): boolean {
  if (!genres || genres.length === 0) return true;
  const genresLower = genres.map((g) => g.toLowerCase());

  const rejected = lists?.rejected ?? rejectedGenres;
  const accepted = lists?.accepted ?? acceptedGenres;

  for (const r of rejected) {
    if (genresLower.some((g) => g.includes(r))) return false;
  }
  for (const a of accepted) {
    if (genresLower.some((g) => g.includes(a))) return true;
  }
  return true;
}

// Instrumental / clean / acoustic version detection patterns
export const instrumentalPattern =
  /[\s\-]*[\(\[]?\s*(instrumental|instrumentals|instrumental version)\s*[\)\]]?\s*$/i;
export const cleanPattern =
  /[\s\-]*[\(\[]?\s*(clean|clean version|clean edit)\s*[\)\]]?\s*$/i;
export const acousticPattern =
  /[\s\-]*[\(\[]?\s*(acoustic|acoustic version|acoustics)\s*[\)\]]?\s*$/i;
export const instrumentalTrackPattern =
  /[\s\-]+(instrumental|inst\.?)$/i;
