/** Normalized dedup key: sorted lowercase artist names joined by "|", then "::trackName". */
export function trackKey(artistNames: string[], trackName: string): string {
  const sorted = artistNames
    .map((n) => n.toLowerCase())
    .sort()
    .join('|');
  return `${sorted}::${trackName.toLowerCase()}`;
}
