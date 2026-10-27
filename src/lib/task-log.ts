/**
 * The task log (ADR-0007): each task's events are worded here on the server,
 * once, by the module that owns them, and printed by the CLI or broadcast to
 * the page as the same lines.
 */

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug';

export interface LogLine {
  level: LogLevel;
  message: string;
}

export const line = (message: string, level: LogLevel = 'info'): LogLine => ({
  level,
  message,
});

/** The CLI's sink: warnings and errors go to stderr. */
export function printLines(lines: LogLine[]): void {
  for (const { level, message } of lines) {
    if (level === 'error') console.error(message);
    else if (level === 'warn') console.warn(message);
    else console.log(message);
  }
}

/** A duration for a log line: `850ms`, `4.2s`, `39m 12s`, `1h 3m`. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}
