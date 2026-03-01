import fs from "node:fs";
import { FileConfigStore } from "../lib/config.js";
import { createSpotifyClient } from "../lib/spotify-client.js";
import { PlaylistFillerService } from "../services/playlist-filler.js";
import type { DateResult } from "../lib/types.js";

const freshMode = process.argv.includes("--fresh");

const configStore = new FileConfigStore();
const client = createSpotifyClient({
  configStore,
  onAuthRequired: (attempt, max) =>
    console.log(`\nAuth failed. Running npm run auth... (attempt ${attempt}/${max})`),
  onAuthSuccess: () => console.log("Authentication successful!\n"),
  onAuthFailed: (err) => console.error("Authentication failed:", err.message),
  onTokenRefreshed: () => {},
});

const service = new PlaylistFillerService(client, { freshMode }, {
  onStart: (dates) => {
    console.log("\n" + "=".repeat(60));
    console.log("BATCH PLAYLIST FILLER - P1 & P2 ONLY");
    console.log("=".repeat(60));
    console.log(`\nDates to process: ${dates.length}`);
    console.log(`Dates: ${dates.join(", ")}`);
    console.log(`Start time: ${new Date().toISOString()}\n`);
  },
  onDateStart: (date, i, total) => {
    console.log(`\n[${"#".repeat(i + 1)}${".".repeat(total - i - 1)}] ${i + 1}/${total}`);
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Processing: ${date}`);
    console.log("=".repeat(60));
  },
  onDateSkipped: (date, reason, trackCount) =>
    console.log(`  ${date}: skipped (${reason}, ${trackCount} tracks)`),
  onPlaylistCreated: (date, id) =>
    console.log(`Created playlist: ${date}`),
  onPlaylistReused: (date, id) =>
    console.log(`  Reusing empty playlist: ${date}`),
  onArtistSearchProgress: (searched, total, _artist) =>
    console.log(`  ... searched ${searched}/${total} artists`),
  onArtistSearchPause: (searched, total) =>
    console.log(`  ... pausing 30s to reset rate limit window`),
  onReleaseFound: (artist, release, type, source) => {
    if (source) {
      console.log(`    Found (${source}): ${artist} - ${release}`);
    } else {
      console.log(`  Found: ${artist} - ${release} (${type})`);
    }
  },
  onVariantPicked: (name, count, isExplicit) =>
    console.log(`    (picked ${isExplicit ? "explicit" : "clean"} version of "${name}" from ${count} variants)`),
  onFiltered: (reason, artist, release, detail) =>
    console.log(`  Filtered out (${reason}${detail ? ` ${detail}` : ""}): ${artist} - ${release}`),
  onDeluxeDetected: (name, baseName, origCount, bonus) =>
    console.log(`  Deluxe detected: "${name}" → base: "${baseName}" (orig: ${origCount}, bonus: ${bonus})`),
  onSingleSkipped: (name) =>
    console.log(`  Skipped single "${name}" - tracks already on album`),
  onDateCompleted: (result) => {
    console.log(`\n  Summary: ${result.tracksAdded} tracks added`);
    console.log(`    Albums: ${result.albumsCount}, Singles: ${result.singlesCount}`);
    console.log(`    Skipped (duplicates): ${result.skippedCount}`);
    console.log(`  URL: ${result.playlistUrl}`);
  },
  onDateError: (date, err) =>
    console.error(`\n  ERROR processing ${date}: ${err.message}`),
  onRateLimitSleep: (hours, wakeTime) => {
    console.log(`\n!!! RATE LIMIT: Sleeping for ${hours} hours...`);
    console.log(`    Will resume at: ${wakeTime.toLocaleTimeString()}`);
  },
  onRecalculating: () =>
    console.log("Playlist changed. Recalculating artist priorities...\n"),
  onBatchComplete: (results, minutes) => {
    console.log("\n" + "=".repeat(60));
    console.log("BATCH COMPLETE");
    console.log("=".repeat(60));
    const skipped = results.filter((r) => r.skipped);
    const created = results.filter((r) => !r.error && !r.skipped);
    const errors = results.filter((r) => r.error);
    console.log(`\nTotal time: ${minutes} minutes`);
    console.log(`Playlists skipped (already existed): ${skipped.length}`);
    console.log(`Playlists created this run: ${created.length}`);
    const totalTracks = results.reduce((sum, r) => sum + (r.tracksAdded || 0), 0);
    console.log(`Total tracks: ${totalTracks}`);
    if (errors.length > 0) {
      console.log(`\nErrors (${errors.length}):`);
      for (const err of errors) console.log(`  ${err.date}: ${err.error}`);
    }
  },
  onLog: (msg) => console.log(msg),
});

const results = await service.run();

// Save progress file (matches old script behavior)
fs.writeFileSync(
  "./batch-p1p2-progress.json",
  JSON.stringify(
    {
      completed: results.filter((r) => !r.error).length,
      total: results.length,
      lastProcessed: results[results.length - 1]?.date,
      results,
    },
    null,
    2,
  ),
);

console.log("\nResults saved to: batch-p1p2-progress.json");
console.log("\n=== Done! ===\n");
