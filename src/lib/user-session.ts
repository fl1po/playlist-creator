import type { SpotifyGateway } from './spotify/gateway.js';
import type { UserData } from './user-data/index.js';

/**
 * One user, as an operation needs them: their Spotify gateway, their id and
 * their user data. The fill, recalculation and clear take one of these and
 * build their own ports from it, so a composition root (the CLI's
 * `cliSession()`, a task's `tc.session`) only chooses where the log goes.
 */
export interface UserSession {
  gateway: SpotifyGateway;
  userId: string;
  data: UserData;
}
