import fs from "node:fs";
import type { TrustedArtistsFile } from "../lib/types.js";

const TRUSTED_ARTISTS_PATH = "./trusted-artists.json";

const data: TrustedArtistsFile = JSON.parse(
  fs.readFileSync(TRUSTED_ARTISTS_PATH, "utf8"),
);
const artists = data.artistCounts;

// Parse CLI args
const args = process.argv.slice(2);
const filterPriorities = new Set<number>();
let sortBy: "score" | "alpha" = "score";

for (const arg of args) {
  if (/^p[1-3]$/i.test(arg)) {
    filterPriorities.add(Number.parseInt(arg[1]));
  } else if (arg === "--alpha") {
    sortBy = "alpha";
  }
}

if (filterPriorities.size === 0) {
  filterPriorities.add(1);
  filterPriorities.add(2);
  filterPriorities.add(3);
}

const filtered = Object.entries(artists)
  .filter(([, d]) => d.priority !== null && filterPriorities.has(d.priority))
  .sort((a, b) => {
    if (sortBy === "alpha") return a[0].localeCompare(b[0]);
    if (a[1].priority !== b[1].priority) return (a[1].priority ?? 99) - (b[1].priority ?? 99);
    return b[1].score - a[1].score;
  });

const grouped = new Map<number, Array<{ name: string; score: number; allWeekly: number; bestOfAllWeekly: number }>>();
for (const [name, d] of filtered) {
  if (d.priority === null) continue;
  if (!grouped.has(d.priority)) grouped.set(d.priority, []);
  grouped.get(d.priority)!.push({ name, score: d.score, allWeekly: d.allWeekly, bestOfAllWeekly: d.bestOfAllWeekly });
}

const priorityLabels: Record<number, string> = {
  1: "P1 (score >= 60)",
  2: "P2 (score 25-59)",
  3: "P3 (score 10-24)",
};

let totalShown = 0;

for (const p of [1, 2, 3]) {
  if (!grouped.has(p)) continue;
  const list = grouped.get(p)!;
  console.log(`\n=== ${priorityLabels[p]} — ${list.length} artists ===\n`);

  for (const a of list) {
    console.log(`  [${String(a.score).padStart(3)}] ${a.name}  (AW:${a.allWeekly} BoAW:${a.bestOfAllWeekly})`);
  }
  totalShown += list.length;
}

console.log(`\n--- Total: ${totalShown} artists ---`);
