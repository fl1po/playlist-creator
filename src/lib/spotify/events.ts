/** What a gateway reports while it waits, retries, or gives up on a call. */
export type SpotifyEvent =
  | { type: 'rateLimitWait'; seconds: number; until: Date }
  | { type: 'longSleep'; hours: number; until: Date }
  | { type: 'longSleepWake' }
  | { type: 'networkRetry'; attempt: number; maxAttempts: number }
  | { type: 'callFailed'; description: string; error: Error };

export type SpotifyEventLevel = 'info' | 'warn';

/** The log line for an event — one wording for the CLI and the web. */
export function describeSpotifyEvent(event: SpotifyEvent): {
  level: SpotifyEventLevel;
  message: string;
} {
  switch (event.type) {
    case 'rateLimitWait': {
      const s = event.seconds;
      const display = s >= 60 ? `${(s / 60).toFixed(1)}min` : `${s}s`;
      return {
        level: 'info',
        message: `  Rate limited, waiting ${display} (until ${event.until.toLocaleTimeString()})...`,
      };
    }
    case 'longSleep':
      return {
        level: 'warn',
        message: `Rate limited — sleeping ${event.hours}h, waking at ${event.until.toLocaleTimeString()}`,
      };
    case 'longSleepWake':
      return { level: 'info', message: 'Rate-limit sleep over, resuming' };
    case 'networkRetry':
      return {
        level: 'info',
        message: `  Network error, retry ${event.attempt}/${event.maxAttempts}`,
      };
    case 'callFailed':
      return {
        level: 'info',
        message: `  Error (${event.description}): ${event.error.message}`,
      };
  }
}

/** Console observer for CLI gateways. */
export function logSpotifyEventToConsole(event: SpotifyEvent): void {
  console.log(describeSpotifyEvent(event).message);
}
