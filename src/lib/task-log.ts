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
