import type express from 'express';
import { type ApiResult, SpotifyAuthLost } from '../lib/spotify/gateway.js';

/** A failed gateway call, raised by `orThrow` for the route's error mapper. */
export class SpotifyCallFailed extends Error {
  constructor(
    readonly failure: Extract<ApiResult<unknown>, { success: false }>,
  ) {
    super(failure.error.message, { cause: failure.error });
    this.name = 'SpotifyCallFailed';
  }
}

/** The call's data, or throw its failure for `spotifyRoute` to map. */
export function orThrow<T>(result: ApiResult<T>): T {
  if (!result.success) throw new SpotifyCallFailed(result);
  return result.data;
}

/**
 * Wrap a route that calls Spotify, mapping what escapes it to HTTP:
 * lost auth → 401 `{ reauth: true }` (the UI shows its login prompt),
 * rate-limited → 429 with `retryAt`, other Spotify failures → 502,
 * anything else → 500.
 */
export function spotifyRoute(
  handler: (req: express.Request, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return (req, res) => {
    handler(req, res).catch((err) => sendSpotifyError(res, err));
  };
}

function sendSpotifyError(res: express.Response, err: unknown): void {
  if (res.headersSent) return;
  if (err instanceof SpotifyAuthLost) {
    res.status(401).json({ error: err.message, reauth: true });
    return;
  }
  if (err instanceof SpotifyCallFailed) {
    const { failure } = err;
    if (failure.kind === 'rate_limited') {
      res.status(429).json({
        error: 'Spotify rate limit — try again later',
        retryAt: failure.retryAt?.toISOString(),
      });
      return;
    }
    res.status(502).json({ error: err.message });
    return;
  }
  res.status(500).json({
    error: err instanceof Error ? err.message : String(err),
  });
}
