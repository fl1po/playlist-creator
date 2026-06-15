/**
 * Throwaway diagnostic: probe the Deezer popularity distribution of the first
 * N P1/P2 artists' releases for the current week (or a wider window). Read-only
 * — no playlists or trusted-artists.json are touched. Safe to delete.
 *
 * Usage: npm run probe-popularity -- [numArtists=50] [numWeeks=1]
 */
import { filterByPriority } from '../domain/artists.js';
import {
  generateFridayDates,
  getValidDates,
  parseDate,
} from '../domain/tracks.js';
import { FileConfigStore } from '../lib/config.js';
import { fetchDeezerPopularities } from '../lib/deezer-popularity.js';
import { spotifyContext } from '../lib/spotify-context.js';
import type { FoundRelease } from '../lib/types.js';
import { type Run, getArtistWindowReleases } from '../services/week-collection/engine.js';
import { spotifyReleaseReads } from '../services/week-collection/spotify-reads.js';
import { FileStorage } from '../services/playlist-filler/storage.js';

// ── Args ───────────────────────────────────────────────────────────────────
const numArtists = Number(process.argv[2] ?? 50) || 50;
const numWeeks = Number(process.argv[3] ?? 1) || 1;

// ── Bootstrap ──────────────────────────────────────────────────────────────
const ctx = spotifyContext({ configStore: new FileConfigStore() });
const storage = new FileStorage('.');
const reads = spotifyReleaseReads(ctx);

const trusted = await storage.loadTrustedArtists();
const roster = filterByPriority(trusted.artistCounts, [1, 2]).slice(0, numArtists);

// ── Week window(s): most recent Friday <= today, going back numWeeks ─────────
const fridays = generateFridayDates(new Date(2025, 0, 1), new Date());
const weeks = fridays.slice(-numWeeks);
const validDates = [...new Set(weeks.flatMap((w) => getValidDates(parseDate(w))))];

console.log('=== Popularity probe (read-only) ===');
console.log(
  `Artists: first ${roster.length} P1/P2   Week(s): ${weeks.join(', ')}\n`,
);

// ── Collect releases in window ───────────────────────────────────────────────
const run: Run = { reads, decisions: [], albumsByArtist: new Map() };
const found = new Map<string, FoundRelease>();

for (let i = 0; i < roster.length; i++) {
  const [name, data] = roster[i];
  process.stdout.write(`\r  searching ${i + 1}/${roster.length}: ${name}`.padEnd(70));
  const artist = data.spotifyId
    ? { id: data.spotifyId, name }
    : await reads.searchArtist(name);
  if (!artist) continue;
  const releases = await getArtistWindowReleases(run, artist.id, validDates);
  for (const r of releases) {
    if (found.has(r.id)) continue;
    found.set(r.id, {
      id: r.id,
      name: r.name,
      type: r.type,
      release_date: r.release_date,
      markets: r.markets,
      artistName: name,
      artistSpotifyId: artist.id,
      priority: data.priority ?? 0,
      score: data.score,
    });
  }
}
console.log(`\n\nFound ${found.size} releases. Fetching Deezer popularity...\n`);

// ── Deezer popularity ────────────────────────────────────────────────────────
const notFound: string[] = [];
const pops = await fetchDeezerPopularities(found, {
  onNotFound: (a, r) => notFound.push(`${a} — ${r}`),
  onProgress: (done, total) =>
    process.stdout.write(`\r  deezer ${done}/${total}`.padEnd(40)),
});
console.log('\n');

// ── Report ───────────────────────────────────────────────────────────────────
const rows = [...found.values()]
  .map((r) => ({ r, pop: pops.get(r.id) }))
  .filter((x) => x.pop !== undefined)
  .sort((a, b) => (a.pop ?? 0) - (b.pop ?? 0));

const values = rows.map((x) => x.pop as number);
const withPop = values.length;
const noPop = found.size - withPop;

console.log('── Releases with a Deezer match (sorted by popularity) ──');
for (const { r, pop } of rows) {
  console.log(`  ${String(pop).padStart(3)}  ${r.artistName} — ${r.name} (${r.type})`);
}

console.log('\n── Histogram ──');
const buckets = new Array(10).fill(0);
for (const v of values) buckets[Math.min(9, Math.floor(v / 10))]++;
for (let b = 0; b < 10; b++) {
  const lo = b * 10;
  const hi = b === 9 ? 100 : b * 10 + 9;
  const label = `${String(lo).padStart(2)}–${String(hi).padStart(3)}`;
  console.log(`  ${label}  ${'█'.repeat(buckets[b])} ${buckets[b]}`);
}

console.log('\n── Survivors at candidate thresholds (of releases WITH popularity) ──');
for (const t of [60, 55, 50, 45, 40, 35, 30, 20]) {
  const pass = values.filter((v) => v >= t).length;
  const pct = withPop ? Math.round((pass / withPop) * 100) : 0;
  console.log(`  >= ${String(t).padStart(2)}:  ${String(pass).padStart(3)}/${withPop}  (${pct}%)`);
}

const sorted = [...values].sort((a, b) => a - b);
const median = withPop
  ? sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
  : 0;
const mean = withPop ? Math.round(values.reduce((a, b) => a + b, 0) / withPop) : 0;

console.log('\n── Summary ──');
console.log(`  releases found:          ${found.size}`);
console.log(`  with Deezer popularity:  ${withPop}`);
console.log(`  NOT found on Deezer:     ${noPop}  (these BYPASS the gate entirely)`);
console.log(`  median popularity:       ${median}`);
console.log(`  mean popularity:         ${mean}`);
if (noPop > 0) {
  console.log(
    `\n  Note: ${noPop} unmatched releases are admitted regardless of threshold,`,
  );
  console.log('  so effective admits at a threshold = (survivors above) + these.');
}
