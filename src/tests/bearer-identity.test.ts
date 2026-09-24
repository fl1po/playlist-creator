import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type express from 'express';
import type { AppConfig } from '../lib/types.js';
import { bearerIdentity } from '../web/bearer-identity.js';

// ── Fixture: a fake Spotify that knows which user owns which token ──────────

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeSpotify(opts: {
  owners: Record<string, string>; // access token -> user id
  refreshes?: Record<string, string>; // refresh token -> new access token
  transient?: boolean;
}) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (opts.transient) return new Response('', { status: 503 });
    if (u.endsWith('/v1/me')) {
      const auth = (init?.headers as Record<string, string>).Authorization;
      const owner = opts.owners[auth.replace('Bearer ', '')];
      return owner
        ? Response.json({ id: owner })
        : new Response('', { status: 401 });
    }
    const refresh = new URLSearchParams(String(init?.body)).get(
      'refresh_token',
    );
    const access = refresh && opts.refreshes?.[refresh];
    return access
      ? Response.json({ access_token: access })
      : new Response('', { status: 400 });
  }) as typeof fetch;
  return calls;
}

const appConfig = { clientId: 'id', clientSecret: 'secret' } as AppConfig;

function run(
  handler: express.Handler,
  headers: Record<string, string>,
): Promise<{ status: number; passed: boolean; req: express.Request }> {
  const req = { headers: { ...headers } } as unknown as express.Request;
  return new Promise((resolve) => {
    const res = {
      status(code: number) {
        return {
          json: () => resolve({ status: code, passed: false, req }),
        };
      },
    } as unknown as express.Response;
    handler(req, res, () => resolve({ status: 200, passed: true, req }));
  });
}

function bearer(token: string, userId: string, refresh = 'r1') {
  return {
    authorization: `Bearer ${token}`,
    'x-user-id': userId,
    'x-refresh-token': refresh,
  };
}

function verifier(onRefreshed = () => {}) {
  return bearerIdentity({
    loadAppConfig: () => appConfig,
    onTokensRefreshed: onRefreshed,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('passes a token that belongs to the claimed user', async () => {
  fakeSpotify({ owners: { tokA: 'alice' } });
  const r = await run(verifier(), bearer('tokA', 'alice'));
  assert.equal(r.passed, true);
});

test('rejects a valid token claiming someone else', async () => {
  fakeSpotify({ owners: { tokA: 'alice' } });
  const r = await run(verifier(), bearer('tokA', 'bob'));
  assert.equal(r.status, 401);
});

test('verifies each token once, and a cached token still cannot switch users', async () => {
  const calls = fakeSpotify({ owners: { tokA: 'alice' } });
  const v = verifier();
  await run(v, bearer('tokA', 'alice'));
  await run(v, bearer('tokA', 'alice'));
  const r = await run(v, bearer('tokA', 'bob'));
  assert.equal(calls.length, 1);
  assert.equal(r.status, 401);
});

test('refreshes an expired token, rewrites the request, and pushes the new pair', async () => {
  fakeSpotify({ owners: { tokNew: 'alice' }, refreshes: { r1: 'tokNew' } });
  const pushed: unknown[] = [];
  const v = verifier((...args: unknown[]) => pushed.push(args));
  const r = await run(v, bearer('tokOld', 'alice'));
  assert.equal(r.passed, true);
  assert.equal(r.req.headers.authorization, 'Bearer tokNew');
  assert.deepEqual(pushed, [
    ['alice', { accessToken: 'tokNew', refreshToken: 'r1' }],
  ]);
});

test('a refresh token for another user does not grant the claimed one', async () => {
  fakeSpotify({ owners: { tokNew: 'mallory' }, refreshes: { r1: 'tokNew' } });
  const r = await run(verifier(), bearer('tokOld', 'alice'));
  assert.equal(r.status, 401);
});

test('rejects an expired token with no usable refresh token', async () => {
  fakeSpotify({ owners: {} });
  const r = await run(verifier(), bearer('tokOld', 'alice', 'bad'));
  assert.equal(r.status, 401);
});

test('Spotify outages are 503, not a rejection', async () => {
  fakeSpotify({ owners: {}, transient: true });
  const r = await run(verifier(), bearer('tokA', 'alice'));
  assert.equal(r.status, 503);
});

test('requests without Bearer pass through untouched', async () => {
  const calls = fakeSpotify({ owners: {} });
  const r = await run(verifier(), {});
  assert.equal(r.passed, true);
  assert.equal(calls.length, 0);
});
