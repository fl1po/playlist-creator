import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type express from 'express';
import type { AppConfig } from '../lib/types.js';
import { createAuthManager } from '../web/auth.js';

// ── Fixture: a fake Spotify where each auth code belongs to one user ────────

const realFetch = globalThis.fetch;
const tmpDirs: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** code -> user id; a code mapped to null makes the token exchange fail with `failBody`. */
function fakeSpotify(codes: Record<string, string | null>, failBody = '') {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/v1/me')) {
      const auth = (init?.headers as Record<string, string>).Authorization;
      return Response.json({ id: auth.replace('Bearer access-', '') });
    }
    const code = new URLSearchParams(String(init?.body)).get('code') ?? '';
    const user = codes[code];
    return user
      ? Response.json({
          access_token: `access-${user}`,
          refresh_token: `refresh-${user}`,
        })
      : new Response(failBody, { status: 400 });
  }) as typeof fetch;
}

function makeManager() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
  tmpDirs.push(dataRoot);
  const appConfig: AppConfig = {
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'http://127.0.0.1:3000/callback',
  } as AppConfig;
  return createAuthManager({
    loadAppConfig: () => appConfig,
    getOrCreateUserSession: (userId) => ({
      userId,
      client: { setTokens: () => {} },
    }),
    getUserDataDir: (userId) => path.join(dataRoot, userId),
    broadcast: () => {},
    broadcastTo: () => {},
    mainPort: 3000,
  });
}

function stateOf(authUrl: string): string {
  return new URL(authUrl).searchParams.get('state') ?? '';
}

async function callback(
  auth: ReturnType<typeof makeManager>,
  query: Record<string, string>,
): Promise<string> {
  let html = '';
  const res = {
    send: (body: string) => {
      html = body;
    },
  } as unknown as express.Response;
  await auth.handleAuthCallback({ query } as unknown as express.Request, res);
  return html;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('two logins started together both complete', async () => {
  fakeSpotify({ 'code-a': 'alice', 'code-b': 'bob' });
  const auth = makeManager();
  const stateA = stateOf(auth.buildAuthUrl());
  const stateB = stateOf(auth.buildAuthUrl());

  const pageB = await callback(auth, { code: 'code-b', state: stateB });
  const pageA = await callback(auth, { code: 'code-a', state: stateA });

  assert.match(pageA, /Welcome, alice/);
  assert.match(pageB, /Welcome, bob/);
});

test('a state cannot be used twice', async () => {
  fakeSpotify({ 'code-a': 'alice' });
  const auth = makeManager();
  const state = stateOf(auth.buildAuthUrl());

  await callback(auth, { code: 'code-a', state });
  const replay = await callback(auth, { code: 'code-a', state });

  assert.match(replay, /State mismatch/);
});

test('an unknown state is rejected', async () => {
  fakeSpotify({ 'code-a': 'alice' });
  const auth = makeManager();
  auth.buildAuthUrl();

  const page = await callback(auth, { code: 'code-a', state: 'forged' });

  assert.match(page, /State mismatch/);
});

test('waitForAuth resolves only for the user who logged in', async () => {
  fakeSpotify({ 'code-b': 'bob' });
  const auth = makeManager();
  let aliceDone = false;
  void auth.waitForAuth('alice').then(() => {
    aliceDone = true;
  });
  const bobWait = auth.waitForAuth('bob');

  await callback(auth, { code: 'code-b', state: stateOf(auth.buildAuthUrl()) });

  assert.equal(await bobWait, true);
  assert.equal(aliceDone, false);
});

test('token exchange errors are HTML-escaped on the failure page', async () => {
  fakeSpotify({ 'code-x': null }, '<script>alert(1)</script>');
  const auth = makeManager();
  const state = stateOf(auth.buildAuthUrl());

  const page = await callback(auth, { code: 'code-x', state });

  assert.doesNotMatch(page, /<script>/);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
