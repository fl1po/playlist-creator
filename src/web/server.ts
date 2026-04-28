import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { AppConfigStore, UserTokenStore } from '../lib/config.js';
import { RequestPacer } from '../lib/request-pacer.js';
import { createSpotifyContext } from '../lib/spotify-context.js';
import type { AppConfig } from '../lib/types.js';
import {
  PlaylistClearerService,
  type PlaylistClearerEventMap,
} from '../services/playlist-clearer.js';
import { createAuthManager, fetchSpotifyUserId } from './auth.js';
import { broadcastEvents, createBroadcaster } from './broadcast.js';
import { createRouteContext } from './route-context.js';
import { authRoutes } from './routes/auth.js';
import { configRoutes } from './routes/config.js';
import { queryRoutes } from './routes/queries.js';
import { createTaskRunner } from './task-runner.js';
import { createTaskMutex } from './task-mutex.js';
import { dedupRemoveTask } from './tasks/dedup-remove.js';
import { dedupScanTask } from './tasks/dedup-scan.js';
import { fillTask, getSearchedArtists } from './tasks/fill.js';
import { awBreakdownTask } from './tasks/aw-breakdown.js';
import { listeningTimeTask } from './tasks/listening-time.js';
import { recalculateTask } from './tasks/recalculate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const PORT = Number(process.env.PORT ?? 3005);

// ── Shared singletons ──────────────────────────────────────────────────────

const pacer = new RequestPacer(1);
const appConfigStore = new AppConfigStore();
const broadcaster = createBroadcaster();
const broadcast = broadcaster.broadcast;

const taskMutex = createTaskMutex((busy, task) => {
  broadcast('status', { busy, task });
});

// ── Route Context ───────────────────────────────────────────────────────────

const auth = createAuthManager({
  loadAppConfig: () => appConfigStore.load(),
  getOrCreateUserSession: (userId, appConfig) =>
    ctx.getOrCreateUserSession(userId, appConfig),
  getUserDataDir: (userId) => ctx.getUserDataDir(userId),
  broadcast,
  mainPort: PORT,
});

const ctx = createRouteContext({
  broadcaster,
  taskMutex,
  pacer,
  appConfigStore,
  auth,
  usersDir: USERS_DIR,
  projectRoot: PROJECT_ROOT,
  port: PORT,
});

// ── Express + WebSocket ─────────────────────────────────────────────────────

const app = express();
app.use(express.json());
const publicDir = fs.existsSync(path.join(__dirname, '../../src/web/public'))
  ? path.join(__dirname, '../../src/web/public')
  : path.join(__dirname, 'public');
app.use(express.static(publicDir));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  broadcaster.addClient(ws, taskMutex.currentTask, getSearchedArtists());
});

// ── Mount route modules ─────────────────────────────────────────────────────

app.use(authRoutes(ctx));
app.use('/api', queryRoutes(ctx));
app.use('/api', configRoutes(ctx));

// ── Register tasks ──────────────────────────────────────────────────────────

const taskRunner = createTaskRunner({ app, routeCtx: ctx });
taskRunner.register(fillTask);
taskRunner.register(recalculateTask);
taskRunner.register(dedupScanTask);
taskRunner.register(dedupRemoveTask);
taskRunner.register(listeningTimeTask);
taskRunner.register(awBreakdownTask);

// ── Simple inline routes ────────────────────────────────────────────────────

// Clear playlist (synchronous — no mutex)
app.post('/api/clear', async (req, res) => {
  const session = ctx.requireSession(req, res);
  if (!session) return;

  const name = req.body?.name?.trim();
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  broadcast('log', {
    level: 'info',
    message: `Clearing playlist "${name}"...`,
  });

  const spotifyCtx = createSpotifyContext(session.client, undefined, pacer);
  const service = new PlaylistClearerService(
    spotifyCtx,
    broadcastEvents<PlaylistClearerEventMap>(broadcast, {
      playlistFound: {
        log: (n, count) => `Found "${n}" (${count} tracks)`,
      },
      playlistNotFound: {
        log: (n) => `Playlist "${n}" not found`,
        level: 'warn',
      },
      cleared: {
        type: 'clear:complete',
        pack: (n, count) => ({ name: n, cleared: count }),
      },
    }),
  );

  try {
    const result = await service.clear(name);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/stop', (_req, res) => {
  if (!taskMutex.currentTask) {
    res.status(400).json({ error: 'No task running' });
    return;
  }
  if (taskMutex.stop()) {
    broadcast('log', {
      level: 'warn',
      message: `Stopping ${taskMutex.currentTask}...`,
    });
    res.json({ ok: true, message: `Stopping ${taskMutex.currentTask}` });
  } else {
    res.json({ ok: true, message: 'Already stopping' });
  }
});

app.post('/api/clear-logs', (_req, res) => {
  broadcaster.clearHistory();
  res.json({ ok: true });
});

app.get('/api/status', (_req, res) => {
  res.json({ busy: !!taskMutex.currentTask, task: taskMutex.currentTask });
});

// ── Migration ───────────────────────────────────────────────────────────────

async function migrateFromLegacy() {
  if (appConfigStore.exists()) return;

  const legacyPath = path.join(PROJECT_ROOT, 'spotify-config.json');
  if (!fs.existsSync(legacyPath)) return;

  console.log('Migrating from legacy single-user config...');

  try {
    const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));

    const appConfig: AppConfig = {
      clientId: legacy.clientId,
      clientSecret: legacy.clientSecret,
      redirectUri: legacy.redirectUri,
    };
    appConfigStore.save(appConfig);
    console.log('  Created data/app-config.json');

    const envUserId = process.env.SPOTIFY_USER_ID;
    if (legacy.accessToken && legacy.refreshToken) {
      let userId: string | null = null;
      let displayName: string | null = null;

      try {
        const user = await fetchSpotifyUserId(legacy.accessToken);
        userId = user.id;
        displayName = user.displayName;
      } catch {
        try {
          const authHeader = `Basic ${Buffer.from(`${appConfig.clientId}:${appConfig.clientSecret}`).toString('base64')}`;
          const params = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: legacy.refreshToken,
          });
          const tokenRes = await fetch(
            'https://accounts.spotify.com/api/token',
            {
              method: 'POST',
              headers: {
                Authorization: authHeader,
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: params,
            },
          );
          if (tokenRes.ok) {
            const data = (await tokenRes.json()) as {
              access_token: string;
              refresh_token?: string;
            };
            legacy.accessToken = data.access_token;
            if (data.refresh_token) legacy.refreshToken = data.refresh_token;
            const user = await fetchSpotifyUserId(data.access_token);
            userId = user.id;
            displayName = user.displayName;
            console.log('  Refreshed expired token for migration');
          } else {
            throw new Error('Refresh failed');
          }
        } catch {
          if (envUserId) {
            userId = envUserId;
            console.log(
              `  Token expired — using SPOTIFY_USER_ID="${envUserId}" for migration`,
            );
          } else {
            console.log(
              `  Warning: Could not fetch userId (token expired) and SPOTIFY_USER_ID not set.`,
            );
            console.log(
              `  Re-run with: SPOTIFY_USER_ID=<your-spotify-id> npm run dashboard`,
            );
            console.log(
              `  Find your ID: Spotify profile > ... > Share > Copy link (ID is in the URL)`,
            );
          }
        }
      }

      if (userId) {
        const userDir = ctx.getUserDataDir(userId);
        fs.mkdirSync(userDir, { recursive: true });

        const tokenStore = new UserTokenStore(userId, userDir);
        tokenStore.save({
          accessToken: legacy.accessToken,
          refreshToken: legacy.refreshToken,
        });
        console.log(
          `  Migrated tokens for user: ${displayName ?? userId} (${userId})`,
        );

        const filesToCopy = [
          { from: 'user-config.json', to: 'user-config.json' },
          { from: 'trusted-artists.json', to: 'trusted-artists.json' },
          { from: 'batch-cache.json', to: 'batch-cache.json' },
          { from: 'batch-p1p2-progress.json', to: 'batch-p1p2-progress.json' },
        ];

        for (const { from, to } of filesToCopy) {
          const srcPath = path.join(PROJECT_ROOT, from);
          if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, path.join(userDir, to));
            console.log(`  Copied ${from} -> data/users/${userId}/${to}`);
          }
        }
      }
    }

    console.log('Migration complete. Legacy files left in place as backup.');
  } catch (err) {
    console.error('Migration failed:', err);
  }
}

// ── Dev: watch public dir for frontend hot reload ───────────────────────────

const srcPublic = path.join(__dirname, '../../src/web/public');
if (fs.existsSync(srcPublic)) {
  let debounce: ReturnType<typeof setTimeout> | null = null;
  fs.watch(srcPublic, { recursive: true }, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => broadcast('reload', {}), 100);
  });
}

// ── Start ───────────────────────────────────────────────────────────────────

migrateFromLegacy().then(() => {
  server.listen(PORT, () => {
    console.log(`Dashboard running at http://localhost:${PORT}`);
  });
});
