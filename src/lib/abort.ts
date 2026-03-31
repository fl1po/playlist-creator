import type { SpotifyClient } from './types.js';

/** Sleep in 1-second chunks, checking abort via client.api between each. */
export async function abortableSleep(
  ms: number,
  client: SpotifyClient,
): Promise<void> {
  const target = Date.now() + ms;
  while (Date.now() < target) {
    void client.api; // throws if aborted
    const remaining = target - Date.now();
    await new Promise((r) => setTimeout(r, Math.min(remaining, 1000)));
  }
}
