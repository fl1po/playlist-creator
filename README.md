# Playlist Creator

Automated weekly playlist generation driven by your own listening history. Spotify Web API for releases and library, Deezer's public API for popularity scoring, optional Upstash Redis for cross-device state.

## Why

Release Radar and Discover Weekly are black boxes that miss artists you care about. Following 900+ artists means 50–100 new releases every Friday — no human checks that manually. This project replaces guesswork with a deterministic priority system derived from your own curation.

## How it works

### Source playlists

The system learns your taste from playlists you maintain yourself:

- **AW (All Weekly)** — comprehensive weekly log of new music you listened to. Every Friday you add what you heard that week.
- **BoAW (Best of All Weekly)** — curated subset of AW. Tracks good enough to keep long-term.
- **Liked Songs** (optional) — counted as a third source if enabled in Settings.

Over time these encode which artists you consistently return to and which ones you value most.

### Step 1: Calculate priorities

Scans AW, BoAW (and optionally Liked Songs) to score every artist:

```
score = (AW_count x awWeight) + (BoAW_count x boawWeight) + recencyBonusAW + recencyBonusBoAW
```

- **BoAW weighted higher** (default x3 vs x2) — keeping a track signals stronger preference than just listening
- **Recency bonuses** — sliding scale rewarding artists who appear more recently in the playlist:

  | Position in playlist | AW bonus | BoAW bonus |
  |---------------------|----------|------------|
  | Top 10%             | +20      | +15        |
  | Top 30%             | +15      | +10        |
  | Top 50% (AW) / 60% (BoAW) | +12 | +5   |
  | Top 80% (AW) / 85% (BoAW) | +10 | +2   |
  | Top 95% (AW)        | +7       | —          |
  | Older               | +5       | +1         |

- **Priority tiers** (default thresholds, configurable):

  | Tier | Score  | Meaning                    |
  |------|--------|----------------------------|
  | P1   | >= 60  | Core artists, always track  |
  | P2   | 25-59  | Strong interest             |
  | P3   | 15-24  | Moderate interest           |
  | P4   | 1-14   | Peripheral                  |

Output: a `trusted-artists` record persisted to disk and/or Redis (per user).

### Step 2: Fill playlists

For each unfilled Friday:

1. Loads **P1 + P2 artists** (recommended < 500)
2. Searches Spotify for new releases within that Friday's date window
3. Checks **editorial playlists** for additional discoveries (configurable list)
4. Checks **external playlist sources** — configurable curator playlists matched by user ID, name regex, and date format
5. Applies smart filtering:
   - **Variant dedup** — picks explicit version with most markets
   - **Deluxe handling** — only adds bonus tracks, skips originals already present
   - **Low popularity removal** — uses Deezer track rank (normalized 0–100) alongside Spotify popularity, drops releases below a configurable threshold
   - **Genre filtering** — configurable accepted/rejected genre lists
   - **Instrumental/clean/acoustic removal** — filters variant editions
   - **AW + Liked Songs dedup** — skips tracks already in your sources
6. Creates a playlist named by date (`DD.MM.YY`) and adds tracks sorted by popularity
7. **Resumable** — batch progress persisted to disk and Redis, picks up where it left off

```
                ┌─────────────────────────────┐
                │  AW + BoAW  (+ Liked Songs) │
                └──────────────┬──────────────┘
                               │
                          Recalculate
                               │
                ┌──────────────▼──────────────┐
                │      trusted-artists        │
                └──────────────┬──────────────┘
                               │
                             Fill
                               │
       ┌───────────────────────┼───────────────────────┐
       │                       │                       │
┌──────▼──────┐       ┌────────▼────────┐     ┌────────▼────────┐
│ P1+P2 scan  │       │ Editorial +     │     │ Deezer pop +    │
│ (Spotify)   │       │ external sources│     │ smart filtering │
└──────┬──────┘       └────────┬────────┘     └────────┬────────┘
       │                       │                       │
       └───────────────────────┼───────────────────────┘
                               │
                  ┌────────────▼────────────┐
                  │   Weekly playlist       │
                  │      (DD.MM.YY)         │
                  └─────────────────────────┘
```

## Web dashboard

The primary interface. Open `http://localhost:3005` after `pnpm web`. From the dashboard you can:

- **Authenticate** — Spotify OAuth runs in-browser, no terminal needed
- **Recalculate** priorities — scan AW + BoAW (+ Liked Songs) and rebuild artist scores
- **Fill** playlists — generate missing weekly playlists with real-time progress
- **Fill (fresh)** — ignore batch cache and start from scratch
- **Stop** any running task mid-execution (resumable)
- **Search artists** — look up any artist's priority, score, and playlist stats
- **Browse artists** — view all tracked artists filtered by priority tier
- **AW Breakdown** — analyze your All Weekly by artist/genre composition
- **Listening Time** — cumulative listening duration across your weekly playlists
- **Dedup Scan / Remove** — find and remove duplicates across target playlists
- **Clear** a playlist by name
- **Settings** — source playlists, editorial playlists, external sources, genre filters, scoring weights and thresholds

All operations stream live logs and progress via WebSocket — you see every release found, every filter applied, and every playlist created in real time.

## Configuration

### Environment variables

| Variable | Required | What it does |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | yes | OAuth client ID from the Spotify Developer dashboard |
| `SPOTIFY_CLIENT_SECRET` | yes | OAuth client secret |
| `SPOTIFY_REDIRECT_URI` | yes | OAuth redirect URI — must match the one registered in Spotify (e.g. `http://127.0.0.1:3005/callback` locally) |
| `SPOTIFY_USER_ID` | optional | App owner's Spotify user ID; used to scope a default user data dir in single-user mode |
| `PORT` | optional | Web server port (defaults to `3005`) |
| `UPSTASH_REDIS_REST_URL` | optional | Upstash Redis REST endpoint. If set together with the token, state is mirrored to Redis |
| `UPSTASH_REDIS_REST_TOKEN` | optional | Upstash Redis REST token |

Without Redis the app runs purely on the filesystem (per-user directories under `data/users/<spotifyUserId>/`). With Redis, the same data is keyed per user (`config:<userId>`, `trustedArtists:<userId>`, `fillHistory:<userId>`, `batchCache:<userId>`) so deployments can survive restarts without a mounted volume.

### Dashboard settings

Configured per user via the Settings panel in the dashboard. Persisted to disk and Redis.

| Section | What you can change |
|---|---|
| **Source Playlists** | AW + BoAW playlist IDs, optional Liked Songs toggle |
| **Editorial Playlists** | List of Spotify playlists to scan for discoveries |
| **External Sources** | Curator playlists matched by user ID + name regex + date format |
| **Genre Filters** | Accepted and rejected genre lists for editorial artist filtering |
| **Scoring** | AW/BoAW weights, P1–P4 thresholds, min popularity, min followers |

Changes take effect on the next Fill or Recalculate.

## Local setup

### Prerequisites

- Node.js 22+
- [pnpm](https://pnpm.io/) (the project ships a `pnpm-lock.yaml`; `corepack enable` is the easiest way)
- Spotify Premium account
- [Spotify Developer app](https://developer.spotify.com/dashboard/) with a redirect URI registered

### Install and run

```bash
git clone https://github.com/fl1po/playlist-creator.git
cd playlist-creator
pnpm install

export SPOTIFY_CLIENT_ID=...
export SPOTIFY_CLIENT_SECRET=...
export SPOTIFY_REDIRECT_URI=http://127.0.0.1:3005/callback

pnpm web
```

Open `http://localhost:3005`, sign in via OAuth, pick AW + BoAW in **Settings**, then run **Recalculate** followed by **Fill**.

### Prepare source playlists

If you don't already have them, create two playlists on Spotify:

1. **All Weekly (AW)** — start adding tracks you listen to each week
2. **Best of All Weekly (BoAW)** — move your favorites from AW here over time

Optionally enable **Liked Songs** as a third source.

## Deployment

The app ships a multi-stage `Dockerfile` and a `railway.json`, so it deploys to Railway (or any container host) with no extra config.

### Docker

```bash
docker build -t playlist-creator .
docker run -p 3005:3005 \
  -e SPOTIFY_CLIENT_ID=... \
  -e SPOTIFY_CLIENT_SECRET=... \
  -e SPOTIFY_REDIRECT_URI=https://your.host/callback \
  -e UPSTASH_REDIS_REST_URL=... \
  -e UPSTASH_REDIS_REST_TOKEN=... \
  playlist-creator
```

The container exposes port `3005` and runs `node build/web/server.js`.

### Railway

`railway.json` points at `Dockerfile`. Set the env vars above as Railway service variables. Redis is recommended in deployed setups — without it, per-user state lives only on the container filesystem and is lost on redeploy.

### Multi-user note

Each Spotify account that signs in gets its own user namespace (Spotify user ID), both on disk (`data/users/<userId>/`) and in Redis (key suffix `<userId>`). OAuth auto-creates a session on first sign-in. There is no admin UI — anyone who can reach the URL and complete OAuth gets their own isolated workspace, so put the deployment behind whatever access control you need.

<details>
<summary>CLI fallback</summary>

All core actions are also available as CLI commands. They read/write the same per-user data files (uses `SPOTIFY_USER_ID` to pick the directory).

| Command | Description |
|---|---|
| `pnpm recalculate` | Rebuild trusted-artists scores |
| `pnpm fill` | Fill missing weekly playlists |
| `pnpm fill:fresh` | Fill ignoring batch cache |
| `pnpm find-artist <name>` | Look up artist priority |
| `pnpm list-artists` | List artists by priority |
| `pnpm clear <playlist>` | Clear a playlist by name |

</details>

## Project structure

```
src/
├── cli/                          # CLI entry points (fill, recalculate, find-artist, list-artists, clear)
├── domain/                       # Pure logic
│   ├── artists.ts                # Scoring formula, recency bonuses, priority tiers
│   ├── releases.ts               # Variant dedup, deluxe detection, grouping
│   ├── tracks.ts                 # Date logic, Friday generation
│   ├── filters.ts                # Genre accept/reject lists
│   └── aw-breakdown.ts           # AW composition analysis
├── lib/                          # Shared infrastructure
│   ├── spotify-client.ts         # Spotify SDK wrapper
│   ├── deezer-client.ts          # Deezer public API client
│   ├── deezer-popularity.ts      # Track rank → 0–100 popularity
│   ├── api-wrapper.ts            # Retry / rate-limit / backoff
│   ├── pagination.ts             # Playlist + album page iteration
│   ├── request-pacer.ts          # Outbound request pacing
│   ├── resilience/               # Retry + backoff primitives
│   ├── config.ts                 # Spotify OAuth token store
│   ├── user-config.ts            # Per-user settings store
│   └── types.ts                  # Shared types
├── services/                     # Orchestration
│   ├── playlist-filler/          # Fill pipeline (see below)
│   ├── playlist-syncer.ts        # Source playlist snapshot diffing
│   ├── release-collector.ts      # New-release scan per artist
│   ├── priority-calculator.ts    # AW/BoAW scan + scoring
│   ├── artist-lookup.ts          # Single-artist search
│   ├── playlist-clearer.ts       # Clear a target playlist
│   └── non-listened-playlists.ts # Find unfilled Fridays
└── web/
    ├── server.ts                 # Express + WebSocket dashboard
    ├── routes/                   # auth, config, queries
    ├── tasks/                    # fill, recalculate, aw-breakdown, listening-time, dedup-scan, dedup-remove
    ├── auth.ts, session.ts       # OAuth flow + session management
    ├── redis-config-store.ts     # Upstash Redis client (optional)
    ├── broadcast.ts              # WebSocket fan-out
    ├── task-runner.ts            # Background task lifecycle
    └── public/                   # Dashboard frontend
```

### `services/playlist-filler/`

The fill pipeline is split into focused modules:

- **`index.ts`** — `runFill()` / `runWebFill()` entry points
- **`orchestrator.ts`** — coordinates release collection, per-date processing, and priority recalculation
- **`date-pipeline.ts`** — processes a single Friday: fetch sources, dedup, filter, add tracks
- **`recalculate.ts`** — detects source snapshot changes and triggers a priority recalc when needed
- **`events.ts`** — typed event map for progress + log streaming
- **`presenter.ts`** — adapts events for CLI console output or WebSocket broadcast
- **`storage.ts`** — dual-backed persistence (filesystem only, or filesystem + Redis + live client broadcast)
