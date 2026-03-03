import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { FileConfigStore } from "../lib/config.js";
import { UserConfigStore } from "../lib/user-config.js";
import { createSpotifyClient } from "../lib/spotify-client.js";
import { createApiCall } from "../lib/api-wrapper.js";
import { getAllUserPlaylists } from "../lib/pagination.js";
import type {
  ArtistData,
  SpotifyClient,
  SpotifyConfig,
  TrustedArtistsFile,
} from "../lib/types.js";
import { filterByPriority } from "../domain/artists.js";
import { PlaylistFillerService } from "../services/playlist-filler.js";
import { PriorityCalculatorService } from "../services/priority-calculator.js";
import { PlaylistClearerService } from "../services/playlist-clearer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRUSTED_ARTISTS_PATH = path.resolve("./trusted-artists.json");
const PORT = Number(process.env.PORT ?? 3005);

// ── Spotify client (shared) ────────────────────────────────────────────────

const configStore = new FileConfigStore();
const userConfigStore = new UserConfigStore();
const client: SpotifyClient = createSpotifyClient({
  configStore,
  onAuthRequired: () =>
    broadcast("log", { level: "warn", message: "Token expired — run `npm run auth` manually and restart" }),
  onAuthFailed: (err) =>
    broadcast("log", { level: "error", message: `Auth failed: ${err.message}` }),
});

// Override runAuth to pause and wait for dashboard auth instead of interactive OAuth
let authResolve: (() => void) | null = null;

client.runAuth = async () => {
  broadcast("log", { level: "warn", message: "Token expired — opening Spotify login. Task paused, waiting..." });

  // Auto-trigger the auth flow
  const url = buildAuthUrl();
  broadcast("auth", { authenticated: false, url });

  // Wait for the user to authenticate via the dashboard
  return new Promise<boolean>((resolve) => {
    authResolve = () => resolve(true);
    // Timeout after 10 minutes
    setTimeout(() => {
      authResolve = null;
      resolve(false);
    }, 10 * 60 * 1000);
  });
};

// ── Task state ──────────────────────────────────────────────────────────────

let currentTask: string | null = null;
let abortFlag: { aborted: boolean } | null = null;
const searchedArtists = new Set<string>();

function restoreSearchedArtistsFromCache() {
  try {
    const cache = JSON.parse(fs.readFileSync("./batch-cache.json", "utf8"));
    const progress = cache?.artistSearchProgress;
    if (progress?.artistsSearched > 0) {
      const trusted = JSON.parse(fs.readFileSync(TRUSTED_ARTISTS_PATH, "utf8"));
      const p1p2 = filterByPriority(trusted.artistCounts, [1, 2]);
      const count = Math.min(progress.artistsSearched, p1p2.length);
      for (let i = 0; i < count; i++) {
        searchedArtists.add(p1p2[i][0]);
      }
      broadcast("fill:searchedArtists", [...searchedArtists]);
      broadcast("log", { level: "info", message: `Restored ${searchedArtists.size} searched artists from cache (date: ${progress.date})` });
    }
  } catch { /* no cache or trusted-artists file */ }
}

function setBusy(task: string): boolean {
  if (currentTask) return false;
  currentTask = task;
  abortFlag = { aborted: false };
  broadcast("status", { busy: true, task });
  return true;
}

function setIdle() {
  currentTask = null;
  abortFlag = null;
  broadcast("status", { busy: false, task: null });
}

function checkAbort(flag: { aborted: boolean }) {
  if (flag.aborted) throw new Error("Stopped by user");
}

// Wrap the shared client so every API access checks the abort flag.
// Services call client.api before every Spotify request, so this
// gives us near-instant abort — no waiting for the next event callback.
function createAbortableClient(flag: { aborted: boolean }): SpotifyClient {
  return {
    get api() {
      checkAbort(flag);
      return client.api;
    },
    refreshToken: () => { checkAbort(flag); return client.refreshToken(); },
    recreateApi: () => { checkAbort(flag); return client.recreateApi(); },
    runAuth: client.runAuth,
  };
}

// ── Express + WebSocket ─────────────────────────────────────────────────────

const app = express();
app.use(express.json());
// In dev (--watch), serve from src; in prod, serve from build
const publicDir = fs.existsSync(path.join(__dirname, "../../src/web/public"))
  ? path.join(__dirname, "../../src/web/public")
  : path.join(__dirname, "public");
app.use(express.static(publicDir));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Set<WebSocket>();

const MAX_LOG_HISTORY = 500;
const logHistory: string[] = [];

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "status", data: { busy: !!currentTask, task: currentTask } }));
  if (searchedArtists.size > 0) {
    ws.send(JSON.stringify({ type: "fill:searchedArtists", data: [...searchedArtists] }));
  }
  for (const msg of logHistory) ws.send(msg);
  ws.on("close", () => clients.delete(ws));
});

// High-frequency or transient types that should not be stored
const SKIP_HISTORY = new Set(["status", "reload", "auth", "fill:searchProgress", "recalc:scanProgress"]);

function broadcast(type: string, data: unknown) {
  const msg = JSON.stringify({ type, data });
  if (!SKIP_HISTORY.has(type)) {
    logHistory.push(msg);
    if (logHistory.length > MAX_LOG_HISTORY) logHistory.splice(0, logHistory.length - MAX_LOG_HISTORY);
  }
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadTrustedArtists(): TrustedArtistsFile | null {
  try {
    return JSON.parse(fs.readFileSync(TRUSTED_ARTISTS_PATH, "utf8"));
  } catch {
    return null;
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

// Fill playlists
app.post("/api/fill", (_req, res) => {
  if (!setBusy("fill")) {
    res.status(409).json({ error: `Busy: "${currentTask}" is running` });
    return;
  }

  const freshMode = !!_req.body?.fresh;
  const abort = abortFlag!;
  const abortableClient = createAbortableClient(abort);
  searchedArtists.clear();
  broadcast("log", { level: "info", message: `Starting playlist fill (fresh=${freshMode})...` });
  if (!freshMode) restoreSearchedArtistsFromCache();

  const userConfig = userConfigStore.load();
  const service = new PlaylistFillerService(abortableClient, {
    freshMode,
    allWeeklyId: userConfig.sourcePlaylists.allWeeklyId,
    bestOfAllWeeklyId: userConfig.sourcePlaylists.bestOfAllWeeklyId,
    editorialPlaylists: userConfig.editorialPlaylists,
    externalPlaylistSources: userConfig.externalPlaylistSources,
    genreFilters: userConfig.genreFilters,
    editorialFilter: userConfig.editorialFilter,
  }, {
    onStart: (dates) => {
      checkAbort(abort);
      broadcast("fill:start", { dates });
    },
    onDateStart: (date, index, total) => {
      checkAbort(abort);
      broadcast("fill:progress", { date, index, total, searched: searchedArtists.size });
    },
    onDateSkipped: (date, reason, trackCount) =>
      broadcast("log", { level: "info", message: `Skipped ${date}: ${reason} (${trackCount} tracks)` }),
    onPlaylistCreated: (date) =>
      broadcast("log", { level: "success", message: `Created playlist: ${date}` }),
    onPlaylistReused: (date) =>
      broadcast("log", { level: "info", message: `Reusing empty playlist: ${date}` }),
    onArtistSearchProgress: (searched, total, artistName) => {
      checkAbort(abort);
      searchedArtists.add(artistName);
      broadcast("fill:searchProgress", { searched, total, artist: artistName });
    },
    onArtistSearchPause: (searched, total) =>
      broadcast("log", { level: "info", message: `Pausing 30s to reset rate limit window (${searched}/${total} artists)` }),
    onReleaseFound: (artist, release, type, source) =>
      broadcast("fill:releaseFound", { artist, release, type, source }),
    onVariantPicked: (name, count, isExplicit) =>
      broadcast("log", { level: "info", message: `Picked ${isExplicit ? "explicit" : "clean"} variant of "${name}" (${count} variants)` }),
    onFiltered: (reason, artist, release, detail) =>
      broadcast("log", { level: "info", message: `Filtered (${reason}${detail ? ` ${detail}` : ""}): ${artist} - ${release}` }),
    onDeluxeDetected: (name, baseName) =>
      broadcast("log", { level: "info", message: `Deluxe detected: "${name}" -> "${baseName}"` }),
    onSingleSkipped: (name) =>
      broadcast("log", { level: "info", message: `Skipped single "${name}" (tracks already on album)` }),
    onDateCompleted: (result) =>
      broadcast("fill:dateComplete", result),
    onDateError: (date, err) =>
      broadcast("fill:error", { date, message: err.message }),
    onRateLimitSleep: (hours, wakeTime) =>
      broadcast("log", { level: "warn", message: `Rate limited — sleeping ${hours}h, waking at ${wakeTime.toLocaleTimeString()}` }),
    onRateLimitWait: (seconds, wakeTime) =>
      broadcast("fill:rateLimited", { seconds, wakeTime: wakeTime.toISOString() }),
    onRecalculating: () =>
      broadcast("log", { level: "info", message: "Playlist changed — recalculating priorities..." }),
    onRecalculated: () =>
      broadcast("fill:recalculated", {}),
    onBatchComplete: (results, duration) => {
      searchedArtists.clear();
      broadcast("fill:complete", { results, duration });
    },
    onLog: (msg) =>
      broadcast("log", { level: "info", message: msg }),
  });

  service.run()
    .then((results) => {
      fs.writeFileSync(
        "./batch-p1p2-progress.json",
        JSON.stringify({ completed: results.filter((r) => !r.error).length, total: results.length, results }, null, 2),
      );
    })
    .catch((err) => {
      if (abort.aborted) {
        broadcast("log", { level: "warn", message: "Fill stopped by user" });
      } else {
        broadcast("fill:error", { date: "batch", message: String(err) });
      }
    })
    .finally(() => { searchedArtists.clear(); setIdle(); });

  res.json({ ok: true, message: "Fill started" });
});

// Recalculate priorities
app.post("/api/recalculate", (_req, res) => {
  if (!setBusy("recalculate")) {
    res.status(409).json({ error: `Busy: "${currentTask}" is running` });
    return;
  }

  const abort = abortFlag!;
  const abortableClient = createAbortableClient(abort);
  broadcast("log", { level: "info", message: "Starting priority recalculation..." });

  const userConfig = userConfigStore.load();
  const service = new PriorityCalculatorService(abortableClient, {
    allWeeklyId: userConfig.sourcePlaylists.allWeeklyId,
    bestOfAllWeeklyId: userConfig.sourcePlaylists.bestOfAllWeeklyId,
    scoringWeights: userConfig.scoring,
    priorityThresholds: userConfig.scoring.priorityThresholds,
  }, {
    onScanStart: (name) => {
      checkAbort(abort);
      broadcast("recalc:scanStart", { playlist: name });
    },
    onScanProgress: (name, offset, total) => {
      checkAbort(abort);
      broadcast("recalc:scanProgress", { playlist: name, offset, total });
    },
    onScanComplete: (name, artistCount, trackCount) =>
      broadcast("recalc:scanProgress", { playlist: name, artists: artistCount, tracks: trackCount }),
    onCalculationComplete: (stats) =>
      broadcast("recalc:complete", stats),
    onTopArtists: (artists) =>
      broadcast("recalc:topArtists", { artists: artists.map(([name, data]) => ({ name, ...data })) }),
    onSaved: (p) =>
      broadcast("log", { level: "success", message: `Saved to ${p}` }),
  });

  service.run()
    .then((output) => {
      fs.writeFileSync(TRUSTED_ARTISTS_PATH, JSON.stringify(output, null, 2));
      broadcast("log", { level: "success", message: "Priorities recalculated and saved" });
    })
    .catch((err) => {
      if (abort.aborted) {
        broadcast("log", { level: "warn", message: "Recalculation stopped by user" });
      } else {
        broadcast("log", { level: "error", message: `Recalculation failed: ${err}` });
      }
    })
    .finally(() => setIdle());

  res.json({ ok: true, message: "Recalculation started" });
});

// Find artist (local JSON search — no Spotify API needed)
app.post("/api/find-artist", (req, res) => {
  const query = req.body?.query?.trim();
  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }

  const trusted = loadTrustedArtists();
  if (!trusted) {
    res.status(500).json({ error: "trusted-artists.json not found — run recalculate first" });
    return;
  }

  const queryLower = query.toLowerCase();
  const artists = trusted.artistCounts;

  // Pre-compute rankings per priority group
  const rankByPriority: Record<number, Array<{ name: string; score: number }>> = {};
  for (const [name, data] of Object.entries(artists)) {
    if (!data.priority) continue;
    if (!rankByPriority[data.priority]) rankByPriority[data.priority] = [];
    rankByPriority[data.priority].push({ name, score: data.score });
  }
  for (const list of Object.values(rankByPriority)) {
    list.sort((a, b) => b.score - a.score);
  }

  const results = Object.entries(artists)
    .filter(([name]) => name.toLowerCase().includes(queryLower))
    .map(([name, data]) => {
      let priorityRank: number | null = null;
      let priorityGroupSize: number | null = null;
      if (data.priority && rankByPriority[data.priority]) {
        const list = rankByPriority[data.priority];
        priorityRank = list.findIndex((a) => a.name === name) + 1;
        priorityGroupSize = list.length;
      }
      return { name, data, priorityRank, priorityGroupSize };
    });

  res.json({ ok: true, results });
});

// Clear playlist
app.post("/api/clear", async (req, res) => {
  const name = req.body?.name?.trim();
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  broadcast("log", { level: "info", message: `Clearing playlist "${name}"...` });

  const service = new PlaylistClearerService(client, {
    onPlaylistFound: (n, count) =>
      broadcast("log", { level: "info", message: `Found "${n}" (${count} tracks)` }),
    onPlaylistNotFound: (n) =>
      broadcast("log", { level: "warn", message: `Playlist "${n}" not found` }),
    onCleared: (n, count) =>
      broadcast("clear:complete", { name: n, cleared: count }),
  });

  try {
    const result = await service.clear(name);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// List artists
app.get("/api/artists", (req, res) => {
  const trusted = loadTrustedArtists();
  if (!trusted) {
    res.status(500).json({ error: "trusted-artists.json not found" });
    return;
  }

  const priorityParam = (req.query.priorities as string) ?? "1,2,3";
  const priorities = new Set(priorityParam.split(",").map(Number).filter(Boolean));
  const sortBy = (req.query.sort as string) === "alpha" ? "alpha" : "score";

  const filtered = Object.entries(trusted.artistCounts)
    .filter(([, d]) => d.priority !== null && priorities.has(d.priority!))
    .sort((a, b) => {
      if (sortBy === "alpha") return a[0].localeCompare(b[0]);
      if (a[1].priority !== b[1].priority) return (a[1].priority ?? 99) - (b[1].priority ?? 99);
      return b[1].score - a[1].score;
    })
    .map(([name, data]) => ({ name, ...data }));

  res.json({ ok: true, artists: filtered, stats: trusted.metadata?.stats });
});

// Stop running task
app.post("/api/stop", (_req, res) => {
  if (!abortFlag || !currentTask) {
    res.status(400).json({ error: "No task running" });
    return;
  }
  if (abortFlag.aborted) {
    res.json({ ok: true, message: "Already stopping" });
    return;
  }
  abortFlag.aborted = true;
  broadcast("log", { level: "warn", message: `Stopping ${currentTask}...` });
  res.json({ ok: true, message: `Stopping ${currentTask}` });
});

// Clear log history
app.post("/api/clear-logs", (_req, res) => {
  logHistory.length = 0;
  res.json({ ok: true });
});

// Status
app.get("/api/status", (_req, res) => {
  res.json({ busy: !!currentTask, task: currentTask });
});

// ── User Config ──────────────────────────────────────────────────────────────

app.get("/api/config", (_req, res) => {
  const config = userConfigStore.load();
  res.json({ ok: true, config, configured: userConfigStore.exists() });
});

app.put("/api/config", (req, res) => {
  const config = req.body;
  if (!config) {
    res.status(400).json({ error: "Config body required" });
    return;
  }

  // Validate
  const errors: string[] = [];
  if (!config.sourcePlaylists?.allWeeklyId) errors.push("All Weekly playlist ID required");
  if (!config.sourcePlaylists?.bestOfAllWeeklyId) errors.push("Best of All Weekly playlist ID required");

  const t = config.scoring?.priorityThresholds;
  if (t && !(t.p1 > t.p2 && t.p2 > t.p3 && t.p3 > t.p4 && t.p4 > 0)) {
    errors.push("Priority thresholds must be descending (P1 > P2 > P3 > P4 > 0)");
  }

  const s = config.scoring;
  if (s && (s.awWeight <= 0 || s.boawWeight <= 0)) {
    errors.push("Scoring weights must be positive");
  }

  if (errors.length > 0) {
    res.status(400).json({ error: errors.join("; ") });
    return;
  }

  userConfigStore.save(config);
  broadcast("log", { level: "success", message: "Settings saved" });
  res.json({ ok: true });
});

app.get("/api/user-playlists", async (_req, res) => {
  try {
    const me = await client.api.currentUser.profile();
    const apiCallFn = createApiCall(client);
    const playlists = await getAllUserPlaylists(client.api, me.id, apiCallFn);
    res.json({ ok: true, playlists });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/search-playlists", async (req, res) => {
  const query = (req.query.q as string)?.trim();
  if (!query) {
    res.status(400).json({ error: "q query parameter required" });
    return;
  }
  try {
    await client.refreshToken();
    const result = await client.api.search(query, ["playlist"], undefined, 20);
    const playlists = (result.playlists?.items ?? []).filter(Boolean).map(
      (p: any) => ({
        id: p.id,
        name: p.name,
        owner: p.owner?.display_name ?? "Unknown",
        trackCount: p.tracks?.total ?? 0,
      }),
    );
    res.json({ ok: true, playlists });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.get("/api/artist-releases", async (req, res) => {
  const artistId = (req.query.id as string)?.trim();
  const after = (req.query.after as string) ?? "";
  const before = (req.query.before as string) ?? "";
  if (!artistId) {
    res.status(400).json({ error: "id query parameter required" });
    return;
  }
  try {
    await client.refreshToken();
    const result: any = await client.api.artists.albums(artistId, "album,single,appears_on", undefined, 50, 0);
    const items = (result.items ?? [])
      .filter((a: any) => (!after || a.release_date >= after) && (!before || a.release_date <= before))
      .map((a: any) => ({
        id: a.id, name: a.name, type: a.album_type, group: a.album_group,
        release_date: a.release_date, markets: a.available_markets?.length ?? 0,
      }));
    res.json({ ok: true, releases: items });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.get("/api/playlist-info", async (req, res) => {
  const id = (req.query.id as string)?.trim();
  if (!id) {
    res.status(400).json({ error: "id query parameter required" });
    return;
  }
  try {
    await client.refreshToken();
    const pl: any = await client.api.playlists.getPlaylist(id);
    res.json({
      ok: true,
      playlist: {
        id: pl.id,
        name: pl.name,
        owner: pl.owner?.display_name ?? "Unknown",
        trackCount: pl.tracks?.total ?? 0,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── Auth ────────────────────────────────────────────────────────────────────

const SCOPES = [
  "user-read-private", "user-read-email",
  "user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing",
  "playlist-read-private", "playlist-modify-private", "playlist-modify-public",
  "user-library-read", "user-library-modify", "user-read-recently-played",
];

let authState: string | null = null;

function buildAuthUrl(): string {
  const config = configStore.load();
  authState = crypto.randomBytes(16).toString("hex");
  const redirectUri = config.redirectUri;
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    state: authState,
    show_dialog: "false",
  });
  // Start temporary callback server if redirect URI is on a different port
  const redirectUrl = new URL(redirectUri);
  const redirectPort = Number(redirectUrl.port) || 80;
  if (redirectPort !== PORT) {
    startCallbackServer(redirectPort, redirectUrl.pathname);
  }
  return `https://accounts.spotify.com/authorize?${params}`;
}

app.get("/api/auth", (_req, res) => {
  res.json({ ok: true, url: buildAuthUrl() });
});

// Handle callback on our own port (if redirect URI matches)
app.get("/callback", (req, res) => handleAuthCallback(req, res));

async function handleAuthCallback(req: express.Request, res: express.Response) {
  const { code, state, error } = req.query as Record<string, string>;

  if (error) {
    res.send("<h1>Auth Failed</h1><p>You can close this tab.</p>");
    broadcast("log", { level: "error", message: `Auth failed: ${error}` });
    return;
  }

  if (state !== authState) {
    res.send("<h1>Auth Failed</h1><p>State mismatch.</p>");
    broadcast("log", { level: "error", message: "Auth failed: state mismatch" });
    return;
  }

  const config = configStore.load();
  const authHeader = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
  });

  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new Error(body);
    }

    const data = await tokenRes.json() as { access_token: string; refresh_token: string };
    config.accessToken = data.access_token;
    config.refreshToken = data.refresh_token;
    configStore.save(config);

    // Recreate the API with fresh tokens
    await client.recreateApi();

    res.send(`<h1>Authenticated!</h1><p>You can close this tab and return to the <a href="http://localhost:${PORT}">dashboard</a>.</p>`);
    broadcast("log", { level: "success", message: "Spotify authenticated successfully" });
    broadcast("auth", { authenticated: true });
    if (authResolve) { authResolve(); authResolve = null; }
  } catch (err) {
    res.send(`<h1>Auth Failed</h1><pre>${String(err)}</pre>`);
    broadcast("log", { level: "error", message: `Token exchange failed: ${err}` });
  }

  authState = null;
}

// Temporary HTTP server on the redirect URI port to catch the OAuth callback
function startCallbackServer(port: number, callbackPath: string) {
  const tmpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname !== callbackPath) {
      res.writeHead(404);
      res.end();
      return;
    }

    // Forward to our auth handler by constructing a minimal express-like req/res
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;

    const code = query.code;
    const state = query.state;
    const error = query.error;

    if (error) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Auth Failed</h1><p>You can close this tab.</p>");
      broadcast("log", { level: "error", message: `Auth failed: ${error}` });
      tmpServer.close();
      return;
    }

    if (state !== authState) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Auth Failed</h1><p>State mismatch.</p>");
      broadcast("log", { level: "error", message: "Auth failed: state mismatch" });
      tmpServer.close();
      return;
    }

    const config = configStore.load();
    const authHeader = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: config.redirectUri,
    });

    try {
      const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        throw new Error(body);
      }

      const data = await tokenRes.json() as { access_token: string; refresh_token: string };
      config.accessToken = data.access_token;
      config.refreshToken = data.refresh_token;
      configStore.save(config);
      await client.recreateApi();

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h1>Authenticated!</h1><p>You can close this tab and return to the <a href="http://localhost:${PORT}">dashboard</a>.</p>`);
      broadcast("log", { level: "success", message: "Spotify authenticated successfully" });
      broadcast("auth", { authenticated: true });
    if (authResolve) { authResolve(); authResolve = null; }
    } catch (err) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h1>Auth Failed</h1><pre>${String(err)}</pre>`);
      broadcast("log", { level: "error", message: `Token exchange failed: ${err}` });
    }

    authState = null;
    tmpServer.close();
  });

  tmpServer.listen(port, "127.0.0.1", () => {
    broadcast("log", { level: "info", message: `Listening for auth callback on port ${port}` });
  });

  // Auto-close after 5 minutes if no callback received
  setTimeout(() => tmpServer.close(), 5 * 60 * 1000);
}

// Check if tokens are valid by making a real API call
app.get("/api/auth/status", async (_req, res) => {
  const config = configStore.load();
  if (!config.accessToken || !config.refreshToken) {
    res.json({ authenticated: false });
    return;
  }
  try {
    await client.refreshToken();
    await client.api.currentUser.profile();
    res.json({ authenticated: true });
  } catch {
    res.json({ authenticated: false });
  }
});

// ── Dev: watch public dir for frontend hot reload ───────────────────────────

const srcPublic = path.join(__dirname, "../../src/web/public");
if (fs.existsSync(srcPublic)) {
  let debounce: ReturnType<typeof setTimeout> | null = null;
  fs.watch(srcPublic, { recursive: true }, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => broadcast("reload", {}), 100);
  });
}

// ── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
