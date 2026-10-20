import { FileConfigStore } from '../lib/config.js';
import { createCliGateway } from '../lib/spotify/gateway.js';
import { localUserData } from '../lib/user-data/index.js';
import type { UserSession } from '../lib/user-session.js';

/**
 * The CLI's user session: the CLI gateway, the user it is logged in as, and
 * user data that is always local, whatever the env says (ADR-0008).
 */
export async function cliSession(): Promise<UserSession> {
  const gateway = createCliGateway({ configStore: new FileConfigStore() });
  const me = await gateway.call(
    (api) => api.currentUser.profile(),
    'user profile',
  );
  if (!me.success) throw me.error;
  return { gateway, userId: me.data.id, data: localUserData('.') };
}
