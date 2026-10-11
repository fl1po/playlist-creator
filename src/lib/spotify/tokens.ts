import type { AppConfig, ConfigStore, UserTokens } from '../types.js';
import { type Clock, untilAborted } from './clock.js';

/**
 * Outcome of one refresh-token grant. `rejected` means the refresh token is
 * dead and only a fresh login helps; `transient` means try again later.
 */
export type RefreshOutcome =
  | {
      kind: 'ok';
      accessToken: string;
      refreshToken?: string;
      expiresIn: number;
    }
  | { kind: 'rejected'; error: Error }
  | { kind: 'transient'; error: Error };

export type RefreshGrant = (
  app: AppConfig,
  refreshToken: string,
) => Promise<RefreshOutcome>;

/** The refresh-token grant against accounts.spotify.com. */
export const spotifyRefreshGrant: RefreshGrant = async (app, refreshToken) => {
  const auth = Buffer.from(`${app.clientId}:${app.clientSecret}`).toString(
    'base64',
  );
  let response: Response;
  try {
    response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
  } catch (e) {
    return {
      kind: 'transient',
      error: e instanceof Error ? e : new Error(String(e)),
    };
  }
  if (response.status >= 500 || response.status === 429) {
    return {
      kind: 'transient',
      error: new Error(`Token refresh failed: HTTP ${response.status}`),
    };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      kind: 'rejected',
      error: new Error(
        `Refresh token rejected: HTTP ${response.status} ${body}`,
      ),
    };
  }
  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  return {
    kind: 'ok',
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in ?? 3600,
  };
};

const TRANSIENT_RETRIES = 5;
const TRANSIENT_BASE_DELAY_MS = 10_000;

/**
 * One user's tokens: the access token in use, when it expires (when known),
 * and the single in-flight refresh every caller shares.
 */
export class TokenState {
  private access: string;
  private refreshValue: string;
  /** Null when the token's age is unknown (loaded from storage, sent by a browser). */
  private expiresAt: number | null = null;
  private inflight: Promise<'ok' | 'rejected'> | null = null;

  readonly app: AppConfig;

  constructor(
    private readonly store: ConfigStore,
    private readonly grant: RefreshGrant,
    private readonly clock: Clock,
  ) {
    const { accessToken, refreshToken, ...app } = store.load();
    this.app = app;
    this.access = accessToken ?? '';
    this.refreshValue = refreshToken ?? '';
  }

  get accessToken(): string {
    return this.access;
  }

  get refreshToken(): string {
    return this.refreshValue;
  }

  /** Whether the access token expires within `marginMs`. */
  expiresWithin(marginMs: number): boolean {
    return (
      this.expiresAt !== null && this.expiresAt - this.clock.now() < marginMs
    );
  }

  /** Install tokens obtained elsewhere. A no-op when nothing changed. */
  set(tokens: UserTokens, expiresInSec?: number): void {
    if (
      tokens.accessToken === this.access &&
      tokens.refreshToken === this.refreshValue
    ) {
      return;
    }
    this.access = tokens.accessToken;
    this.refreshValue = tokens.refreshToken;
    this.expiresAt =
      expiresInSec === undefined
        ? null
        : this.clock.now() + expiresInSec * 1000;
    this.persist();
  }

  /**
   * Refresh the access token, sharing one grant across concurrent callers.
   * Transient failures are retried; `rejected` means the refresh token is dead.
   * A stop interrupts only this caller's wait, never the shared refresh.
   */
  async refresh(signal?: AbortSignal): Promise<'ok' | 'rejected'> {
    this.inflight ??= this.runRefresh().finally(() => {
      this.inflight = null;
    });
    return untilAborted(this.inflight, signal);
  }

  private async runRefresh(): Promise<'ok' | 'rejected'> {
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.grant(this.app, this.refreshValue);
      if (outcome.kind === 'ok') {
        this.access = outcome.accessToken;
        if (outcome.refreshToken) this.refreshValue = outcome.refreshToken;
        this.expiresAt = this.clock.now() + outcome.expiresIn * 1000;
        this.persist();
        return 'ok';
      }
      if (outcome.kind === 'rejected') return 'rejected';
      if (attempt >= TRANSIENT_RETRIES) throw outcome.error;
      await this.clock.sleep(TRANSIENT_BASE_DELAY_MS * (attempt + 1));
    }
  }

  private persist(): void {
    this.store.save({
      ...this.app,
      accessToken: this.access,
      refreshToken: this.refreshValue,
    });
  }
}
