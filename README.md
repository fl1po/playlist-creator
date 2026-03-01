# Playlist Creator

Automated weekly playlist generation driven by your own listening history. Uses the Spotify Web API directly — no external services needed.

## Why

Release Radar and Discover Weekly are black boxes that miss artists you care about. Following 900+ artists means 50-100 new releases every Friday — no human checks that manually. This project replaces guesswork with a deterministic priority system derived from your own curation.

## How it works

### Source playlists

The system learns your taste from two manually maintained playlists:

- **AW (All Weekly)** — comprehensive weekly log of new music you listened to. Every Friday you add what you heard that week.
- **BoAW (Best of All Weekly)** — curated subset of AW. Tracks good enough to keep long-term.

Over time these playlists encode which artists you consistently return to and which ones you value most.

### Step 1: Calculate priorities

Scans AW and BoAW to score every artist:

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

Output: `trusted-artists.json`

### Step 2: Fill playlists

For each unfilled Friday:

1. Loads **P1 + P2 artists** (recommended < 500)
2. Searches Spotify for new releases within that Friday's date window
3. Checks **editorial playlists** for additional discoveries (configurable list)
4. Checks **external playlist sources** — configurable curator playlists matched by user ID, name regex, and date format
5. Applies smart filtering:
   - **Variant dedup** — picks explicit version with most markets
   - **Deluxe handling** — only adds bonus tracks, skips originals already present
   - **Low popularity removal** — drops releases below configurable threshold
   - **Genre filtering** — configurable accepted/rejected genre lists
   - **Instrumental/clean/acoustic removal** — filters variant editions
   - **AW dedup** — skips tracks already in All Weekly
6. Creates a playlist named by date (`DD.MM.YY`) and adds tracks sorted by popularity
7. **Resumable** — progress saved to `batch-cache.json`, picks up where it left off

```
                        ┌─────────────────┐
                        │  AW + BoAW      │
                        │  playlists      │
                        └────────┬────────┘
                                 │
                            Recalculate
                                 │
                        ┌────────▼────────┐
                        │ trusted-artists │
                        │     .json       │
                        └────────┬────────┘
                                 │
                               Fill
                                 │
               ┌─────────────────┼──────────────────┐
               │                 │                   │
      ┌────────▼───────┐ ┌──────▼──────┐  ┌─────────▼────────┐
      │  P1+P2 artist  │ │  Editorial  │  │  Smart filtering │
      │  release scan  │ │  + external │  │  & dedup         │
      └────────┬───────┘ └──────┬──────┘  └─────────┬────────┘
               │                │                    │
               └────────────────┼────────────────────┘
                                │
                       ┌────────▼────────┐
                       │  Weekly playlist│
                       │   (DD.MM.YY)    │
                       └─────────────────┘
```

## Configuration

All settings are managed via the **Settings** panel in the web dashboard (gear icon in the header). On first launch, the app uses sensible defaults. Settings are persisted to `user-config.json`.

### Configurable settings

| Section | What you can change |
|---------|-------------------|
| **Source Playlists** | AW and BoAW playlist IDs (picked from your Spotify library) |
| **Editorial Playlists** | List of Spotify playlists to scan for discoveries (search any public playlist) |
| **External Sources** | Curator playlists matched by user ID + name regex + date format |
| **Genre Filters** | Accepted and rejected genre lists for editorial artist filtering |
| **Scoring** | AW/BoAW weights, P1-P4 thresholds, min popularity, min followers |

Changes take effect on the next Fill or Recalculate run.

## Web dashboard

The primary interface. Start it with:

```bash
npm run web
```

Opens at `http://localhost:3005`. From the dashboard you can:

- **Recalculate** priorities — scan AW + BoAW and rebuild artist scores
- **Fill** playlists — generate missing weekly playlists with real-time progress
- **Fill (fresh)** — ignore batch cache and start from scratch
- **Stop** any running task mid-execution (resumable)
- **Search artists** — look up any artist's priority, score, and playlist stats
- **Browse artists** — view all tracked artists filtered by priority tier
- **Clear** a playlist by name
- **Settings** — configure source playlists, editorial playlists, genre filters, scoring weights and thresholds
- **Authenticate** — OAuth flow runs in-browser, no terminal needed

All operations stream live logs and progress via WebSocket — you see every release found, every filter applied, and every playlist created in real time.

## Setup

### Prerequisites

- Node.js v16+
- Spotify Premium account
- [Spotify Developer app](https://developer.spotify.com/dashboard/)

### Installation

```bash
git clone https://github.com/fl1po/playlist-creator.git
cd playlist-creator
npm install
npm run build
```

### Configure Spotify credentials

1. Create an app at the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard/)
2. Set redirect URI to `http://127.0.0.1:8888/callback`
3. Create `spotify-config.json` in the project root:

```json
{
  "clientId": "your-client-id",
  "clientSecret": "your-client-secret",
  "redirectUri": "http://127.0.0.1:8888/callback"
}
```

### Prepare source playlists

Create two playlists on Spotify:

1. **All Weekly (AW)** — start adding tracks you listen to each week
2. **Best of All Weekly (BoAW)** — move your favorites from AW here over time

### Run

```bash
npm run web
```

Open `http://localhost:3005`, authenticate via the dashboard, then configure your source playlists in **Settings** (gear icon). Hit **Recalculate** followed by **Fill**.

<details>
<summary>CLI fallback</summary>

All dashboard actions are also available as CLI commands (use default config values — configure via web dashboard for custom settings):

| Command | Description |
|---------|-------------|
| `npm run recalculate` | Rebuild `trusted-artists.json` |
| `npm run fill` | Fill missing weekly playlists |
| `npm run fill:fresh` | Fill ignoring batch cache |
| `npm run find-artist -- <name>` | Look up artist priority |
| `npm run list-artists` | List artists by priority |
| `npm run clear -- <playlist>` | Clear a playlist |

</details>

## Project structure

```
src/
├── lib/
│   ├── config.ts         # FileConfigStore (Spotify OAuth tokens)
│   ├── user-config.ts    # UserConfigStore (user settings)
│   ├── spotify-client.ts # SpotifyClient abstraction
│   ├── api-wrapper.ts    # Retry/rate-limit/backoff wrapper
│   ├── pagination.ts     # Playlist/album track pagination
│   └── types.ts          # Shared types
├── domain/
│   ├── artists.ts        # Scoring formula, recency bonuses, priority tiers
│   ├── releases.ts       # Variant dedup, deluxe detection, grouping
│   ├── filters.ts        # Genre accept/reject lists
│   └── tracks.ts         # Date logic, Friday generation
├── services/
│   ├── playlist-filler.ts    # Weekly playlist fill orchestration
│   ├── priority-calculator.ts # AW/BoAW scan and scoring
│   ├── artist-lookup.ts      # Artist search service
│   └── playlist-clearer.ts   # Playlist clearing service
├── cli/                  # CLI wrappers for all services
└── web/
    ├── server.ts         # Express + WebSocket dashboard server
    └── public/           # Dashboard frontend
```
