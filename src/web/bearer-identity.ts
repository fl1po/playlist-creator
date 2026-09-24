import type express from 'express';
import type { AppConfig } from '../lib/types.js';
import { getBearerToken, getRefreshToken } from './session.js';

/**
 * Bearer-mode requests name their user in `X-User-Id`, and `requireSession`
 * builds that user's session from whatever tokens came with it. Without this
 * check any token holder could claim any user id — and swap their own tokens
 * into that user's session. This middleware proves the access token belongs
 * to the claimed user (Spotify `/me`) before the request reaches a route.
 *
 * An expired access token is refreshed here rather than rejected, so a server
 * restart doesn't force every client through the re-auth banner. The request
 * is rewritten to carry the fresh token, and the client is sent the new pair.
 */

interface Verified {
  userId: string;
  /** Set when the presented token was expired and has been refreshed. */
  replacement?: { accessToken: string; refreshToken: string };
  expires: number;
}

type Lookup =
  | { kind: 'ok'; userId: string }
  | { kind: 'rejected' }
  | { kind: 'transient' };

export interface BearerIdentityDeps {
  loadAppConfig: () => AppConfig;
  onTokensRefreshed: (
    userId: string,
    tokens: { accessToken: string; refreshToken: string },
  ) => void;
}

// Spotify access tokens live for an hour; never trust a verification longer.
const VERIFIED_TTL_MS = 55 * 60 * 1000;
// Soft cap: once reached, expired entries are pruned on the next insert.
const PRUNE_AT = 1000;

async function lookupOwner(accessToken: string): Promise<Lookup> {
  try {
    const res = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { id: string };
      return { kind: 'ok', userId: data.id };
    }
    return res.status === 401 || res.status === 403
      ? { kind: 'rejected' }
      : { kind: 'transient' };
  } catch {
    return { kind: 'transient' };
  }
}

async function refreshAccessToken(
  refreshToken: string,
  appConfig: AppConfig,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refreshToken);
  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${appConfig.clientId}:${appConfig.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
    };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
    };
  } catch {
    return null;
  }
}

export function bearerIdentity(deps: BearerIdentityDeps): express.Handler {
  const verified = new Map<string, Verified>(); // presented access token -> owner

  function remember(accessToken: string, entry: Omit<Verified, 'expires'>) {
    const now = Date.now();
    if (verified.size >= PRUNE_AT) {
      for (const [k, v] of verified) if (v.expires < now) verified.delete(k);
    }
    verified.set(accessToken, { ...entry, expires: now + VERIFIED_TTL_MS });
  }

  /** Point the request at the refreshed pair, so the session is built from it. */
  function useReplacement(
    req: express.Request,
    replacement: Verified['replacement'],
  ) {
    if (!replacement) return;
    req.headers.authorization = `Bearer ${replacement.accessToken}`;
    req.headers['x-refresh-token'] = replacement.refreshToken;
  }

  function reject(res: express.Response) {
    res.status(401).json({ error: 'Token does not belong to this user' });
  }

  return async (req, res, next) => {
    const accessToken = getBearerToken(req);
    const claimed = req.headers['x-user-id'];
    // No Bearer, or no claimed user: nothing to vouch for. requireSession
    // rejects Bearer requests without X-User-Id on its own.
    if (!accessToken || typeof claimed !== 'string' || !claimed) {
      next();
      return;
    }

    const hit = verified.get(accessToken);
    if (hit && hit.expires > Date.now()) {
      if (hit.userId !== claimed) return reject(res);
      useReplacement(req, hit.replacement);
      next();
      return;
    }

    const owner = await lookupOwner(accessToken);
    if (owner.kind === 'ok') {
      remember(accessToken, { userId: owner.userId });
      if (owner.userId !== claimed) return reject(res);
      next();
      return;
    }
    if (owner.kind === 'transient') {
      res.status(503).json({ error: 'Could not verify Spotify token' });
      return;
    }

    // Expired or revoked — a valid refresh token still proves ownership.
    const refreshToken = getRefreshToken(req);
    const appConfig = (() => {
      try {
        return deps.loadAppConfig();
      } catch {
        return null;
      }
    })();
    const fresh =
      refreshToken && appConfig
        ? await refreshAccessToken(refreshToken, appConfig)
        : null;
    if (!fresh) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const refreshedOwner = await lookupOwner(fresh.accessToken);
    if (refreshedOwner.kind !== 'ok') {
      res.status(refreshedOwner.kind === 'transient' ? 503 : 401).json({
        error: 'Not authenticated',
      });
      return;
    }
    // Later requests still carrying the expired token are rewritten without
    // another round-trip until the client picks up the pushed pair.
    remember(accessToken, {
      userId: refreshedOwner.userId,
      replacement: fresh,
    });
    remember(fresh.accessToken, { userId: refreshedOwner.userId });
    if (refreshedOwner.userId !== claimed) return reject(res);
    deps.onTokensRefreshed(refreshedOwner.userId, fresh);
    useReplacement(req, fresh);
    next();
  };
}
