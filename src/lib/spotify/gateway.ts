import { SpotifyApi } from '@spotify/web-api-ts-sdk';
import type { ConfigStore, UserTokens } from '../types.js';
import type { SpotifyCall } from './call-stats.js';
import { type Clock, systemClock, untilAborted } from './clock.js';
import {
  classifyError,
  isAbort,
  RateLimitError,
  SpotifyAuthLost,
} from './errors.js';
import { logSpotifyEventToConsole, type SpotifyEvent } from './events.js';
import { timedFetch } from './http.js';
import { type Lane, RequestPacer } from './pacer.js';
import { RetryAfterResponseValidator } from './response-validator.js';
import {
  type RefreshGrant,
  spotifyRefreshGrant,
  TokenState,
} from './tokens.js';

export { isAbort, SpotifyAuthLost, TaskAborted } from './errors.js';
export type { SpotifyEvent } from './events.js';
export type { Lane } from './pacer.js';
export { RequestPacer } from './pacer.js';

/**
 * Why a call failed after the gateway's own retries. `rate_limited` only
 * reaches interactive callers (background calls wait it out); `client` is a
 * 4xx other than 401/429, e.g. a 404; `unknown` is anything unclassified.
 */
export type FailureKind =
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'client'
  | 'unknown';

export type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: Error; kind: FailureKind; retryAt?: Date };

/**
 * The only way to reach Spotify. The SDK exists only inside `call`, so every
 * request is paced, retried, kept authenticated, and stoppable.
 *
 * - Losing auth for good throws `SpotifyAuthLost`.
 * - A stop throws the signal's reason (`TaskAborted` for tasks).
 * - Every other failure comes back as `{ success: false, kind }`.
 */
export interface SpotifyGateway {
  call<T>(
    fn: (api: SpotifyApi) => Promise<T>,
    description: string,
  ): Promise<ApiResult<T>>;
  /** Aborts when the owner stops the task; absent outside tasks. */
  readonly signal?: AbortSignal;
}

/** A user's gateway: interactive lane, plus the views tasks run on. */
export interface SessionGateway extends SpotifyGateway {
  /**
   * The same user and tokens on the background lane: honours `signal`,
   * waits out rate-limit bans, and re-authenticates by waiting for a login.
   */
  forTask(opts: {
    signal: AbortSignal;
    onEvent?: (event: SpotifyEvent) => void;
  }): SpotifyGateway;
  /** Install tokens obtained elsewhere (a web login, a rotated Bearer token). */
  setTokens(tokens: UserTokens, expiresInSec?: number): void;
}

export interface RetryPolicy {
  server: { maxRetries: number; baseDelayMs: number };
  network: { maxRetries: number; baseDelayMs: number };
  rateLimit: {
    maxRetries: number;
    longSleepMs: (count: number) => number;
  };
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  server: { maxRetries: 3, baseDelayMs: 5000 },
  network: { maxRetries: 10, baseDelayMs: 10000 },
  rateLimit: {
    maxRetries: 5,
    longSleepMs: (n) => (1 + n) * 60 * 60 * 1000,
  },
};

/** Refresh ahead of expiry so a long task never discovers it through a 401. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** An interactive call waits out a short Retry-After, never a longer one. */
const INTERACTIVE_MAX_WAIT_S = 10;

export interface GatewayOptions {
  /** App credentials plus this user's tokens; refreshed tokens are saved back. */
  configStore: ConfigStore;
  /** Shared server-wide on the web (ADR-0003). */
  pacer: RequestPacer;
  /** Lane for calls made on this gateway itself. Default: interactive. */
  lane?: Lane;
  /**
   * Background-lane recovery once the refresh token is rejected. Resolves true
   * once fresh tokens have been installed through `setTokens`.
   */
  reauth?: () => Promise<boolean>;
  /** Appended to `SpotifyAuthLost` messages: how the user gets auth back. */
  authLostHint?: string;
  /** Observer for calls made on this gateway itself. */
  onEvent?: (event: SpotifyEvent) => void;
  /** Sees every attempt that reaches Spotify, on every lane and view. */
  onCall?: (call: SpotifyCall) => void;
  // Internal seams — tests swap these.
  sdk?: (clientId: string, tokens: UserTokens) => SpotifyApi;
  grant?: RefreshGrant;
  clock?: Clock;
  retry?: Partial<RetryPolicy>;
}

function buildSdk(clientId: string, tokens: UserTokens): SpotifyApi {
  return SpotifyApi.withAccessToken(
    clientId,
    {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: tokens.refreshToken,
    },
    {
      responseValidator: new RetryAfterResponseValidator(),
      fetch: timedFetch(),
    },
  );
}

export function createSpotifyGateway(opts: GatewayOptions): SessionGateway {
  const clock = opts.clock ?? systemClock;
  const sdk = opts.sdk ?? buildSdk;
  const policy: RetryPolicy = {
    server: { ...DEFAULT_RETRY_POLICY.server, ...opts.retry?.server },
    network: { ...DEFAULT_RETRY_POLICY.network, ...opts.retry?.network },
    rateLimit: { ...DEFAULT_RETRY_POLICY.rateLimit, ...opts.retry?.rateLimit },
  };
  const tokens = new TokenState(
    opts.configStore,
    opts.grant ?? spotifyRefreshGrant,
    clock,
  );
  const { pacer } = opts;

  let built: { token: string; api: SpotifyApi } | null = null;
  function api(): SpotifyApi {
    if (built?.token !== tokens.accessToken) {
      built = {
        token: tokens.accessToken,
        api: sdk(tokens.app.clientId, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        }),
      };
    }
    return built.api;
  }

  // One login wait, however many calls discover the dead refresh token.
  let reauthInflight: Promise<boolean> | null = null;
  function reauthOnce(reauth: () => Promise<boolean>): Promise<boolean> {
    reauthInflight ??= reauth().finally(() => {
      reauthInflight = null;
    });
    return reauthInflight;
  }

  function authLost(reason: string, cause: unknown): SpotifyAuthLost {
    const hint = opts.authLostHint ? ` ${opts.authLostHint}` : '';
    return new SpotifyAuthLost(`${reason}.${hint}`, { cause });
  }

  function view(
    lane: Lane,
    signal: AbortSignal | undefined,
    onEvent: ((event: SpotifyEvent) => void) | undefined,
  ): SpotifyGateway {
    let longSleepCount = 0;

    /** Get a working access token back, or throw `SpotifyAuthLost`. */
    async function recoverAuth(cause: unknown): Promise<void> {
      if ((await tokens.refresh(signal)) === 'ok') return;
      if (lane === 'interactive' || !opts.reauth) {
        throw authLost('Spotify rejected the refresh token', cause);
      }
      const ok = await untilAborted(reauthOnce(opts.reauth), signal);
      if (!ok) throw authLost('Spotify re-authentication failed', cause);
    }

    function failure<T>(
      kind: FailureKind,
      error: Error,
      description: string,
      retryAt?: Date,
    ): ApiResult<T> {
      if (!error.message.includes('404')) {
        onEvent?.({ type: 'callFailed', description, error });
      }
      return { success: false, error, kind, retryAt };
    }

    async function call<T>(
      fn: (api: SpotifyApi) => Promise<T>,
      description: string,
    ): Promise<ApiResult<T>> {
      let retry = 0;
      let authRetried = false;

      while (true) {
        signal?.throwIfAborted();

        const bannedUntil = pacer.bannedUntil();
        if (bannedUntil !== null) {
          if (lane === 'interactive') {
            return failure(
              'rate_limited',
              new RateLimitError(null),
              description,
              new Date(bannedUntil),
            );
          }
          // A ban another call learned of: wait it out and say so, rather
          // than queue behind interactive calls that never reach Spotify.
          const waitMs = bannedUntil - clock.now();
          onEvent?.({
            type: 'rateLimitWait',
            seconds: Math.ceil(waitMs / 1000),
            until: new Date(bannedUntil),
          });
          await clock.sleep(waitMs, signal);
          continue;
        }

        let usedToken = tokens.accessToken;
        let attempted = false;
        try {
          if (tokens.expiresWithin(REFRESH_MARGIN_MS)) {
            await recoverAuth(new Error('Access token about to expire'));
          }
          await pacer.pace(lane, signal);
          usedToken = tokens.accessToken;
          attempted = true;
          const data = await fn(api());
          opts.onCall?.({ lane, description, outcome: 'ok' });
          pacer.onSuccess();
          longSleepCount = 0;
          return { success: true, data };
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          if (isAbort(err) || err instanceof SpotifyAuthLost) throw err;

          const classified = classifyError(err);
          if (attempted) {
            opts.onCall?.(
              classified.kind === 'rate_limit'
                ? {
                    lane,
                    description,
                    outcome: 'rate_limited',
                    ...(classified.retryAfterSeconds != null && {
                      retryAfterSeconds: classified.retryAfterSeconds,
                    }),
                  }
                : { lane, description, outcome: 'failed' },
            );
          }
          switch (classified.kind) {
            case 'auth': {
              // Someone else already replaced the token this call used.
              if (tokens.accessToken !== usedToken) continue;
              if (authRetried) {
                throw authLost(
                  'Spotify rejected a freshly refreshed token',
                  err,
                );
              }
              authRetried = true;
              try {
                await recoverAuth(err);
              } catch (recoverErr) {
                if (
                  isAbort(recoverErr) ||
                  recoverErr instanceof SpotifyAuthLost
                ) {
                  throw recoverErr;
                }
                // The refresh kept failing transiently.
                return failure(
                  'network',
                  recoverErr instanceof Error ? recoverErr : err,
                  description,
                );
              }
              continue;
            }

            case 'server': {
              if (retry >= policy.server.maxRetries) {
                return failure('server', err, description);
              }
              await clock.sleep(
                policy.server.baseDelayMs * (retry + 1),
                signal,
              );
              retry++;
              continue;
            }

            case 'network': {
              if (retry >= policy.network.maxRetries) {
                return failure('network', err, description);
              }
              onEvent?.({
                type: 'networkRetry',
                attempt: retry + 1,
                maxAttempts: policy.network.maxRetries,
              });
              await clock.sleep(
                policy.network.baseDelayMs * (retry + 1),
                signal,
              );
              retry++;
              continue;
            }

            case 'rate_limit': {
              pacer.onRateLimit();
              const waitS =
                classified.retryAfterSeconds != null
                  ? classified.retryAfterSeconds + 1
                  : 60 * (retry + 1);
              // Spotify named the end of the limit: no call on this server
              // should spend a request rediscovering it before then.
              if (classified.retryAfterSeconds != null) {
                pacer.ban(clock.now() + waitS * 1000);
              }

              if (lane === 'interactive') {
                if (
                  waitS > INTERACTIVE_MAX_WAIT_S ||
                  retry >= policy.rateLimit.maxRetries
                ) {
                  return failure(
                    'rate_limited',
                    err,
                    description,
                    new Date(clock.now() + waitS * 1000),
                  );
                }
              } else if (retry >= policy.rateLimit.maxRetries) {
                // Persistent 429s past the short Retry-After waits mean an
                // app-level ban: sleep for hours, longer on each consecutive one.
                longSleepCount++;
                const sleepMs = policy.rateLimit.longSleepMs(longSleepCount);
                const until = new Date(clock.now() + sleepMs);
                pacer.ban(until.getTime());
                onEvent?.({
                  type: 'longSleep',
                  hours: sleepMs / (60 * 60 * 1000),
                  until,
                });
                await clock.sleep(sleepMs, signal);
                onEvent?.({ type: 'longSleepWake' });
                // The access token has likely expired during the sleep.
                await recoverAuth(err);
                retry = 0;
                continue;
              }

              onEvent?.({
                type: 'rateLimitWait',
                seconds: waitS,
                until: new Date(clock.now() + waitS * 1000),
              });
              await clock.sleep(waitS * 1000, signal);
              retry++;
              continue;
            }

            default: {
              const status = classified.statusCode;
              const kind: FailureKind =
                status !== undefined && status >= 400 && status < 500
                  ? 'client'
                  : 'unknown';
              return failure(kind, err, description);
            }
          }
        }
      }
    }

    return { call, signal };
  }

  const own = view(opts.lane ?? 'interactive', undefined, opts.onEvent);
  return {
    call: own.call,
    forTask: ({ signal, onEvent }) => view('background', signal, onEvent),
    setTokens: (t, expiresInSec) => tokens.set(t, expiresInSec),
  };
}

/**
 * A CLI gateway: its own pacer at 1 req/s, the background lane, and console
 * events. There is no interactive login here, so a rejected refresh token
 * ends the run with `SpotifyAuthLost`.
 */
export function createCliGateway(opts: {
  configStore: ConfigStore;
  onEvent?: (event: SpotifyEvent) => void;
}): SpotifyGateway {
  return createSpotifyGateway({
    configStore: opts.configStore,
    pacer: new RequestPacer(1),
    lane: 'background',
    onEvent: opts.onEvent ?? logSpotifyEventToConsole,
    authLostHint:
      'Log in through the web app, then copy the fresh accessToken/refreshToken into spotify-config.json.',
  });
}
