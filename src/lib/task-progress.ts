/**
 * What a running task reports about where it is (ADR-0006). The task runner
 * holds it, shows it to the task's owner only, and drops it when the task
 * ends. Lives in `lib/` so the services' web subscribers can report through
 * it without depending on `web/`.
 */
export type StepState = 'pending' | 'active' | 'done' | 'skipped' | 'error';

export interface TaskProgress {
  /** Declare the step strip (a fill's dates); every step starts pending. */
  steps(labels: string[]): void;
  step(index: number, state: StepState): void;
  /** Show or update the bar `key`, with the text shown beside it. */
  bar(key: string, value: number, total: number, text: string): void;
  clearBar(key: string): void;
  /** Mark names as handled, e.g. the artists a fill has searched. */
  mark(...names: string[]): void;
}

export interface ProgressView {
  steps: Array<{ label: string; state: StepState }>;
  bars: Array<{ key: string; value: number; total: number; text: string }>;
  marked: string[];
  /** Epoch ms a rate-limit wait ends; gone once the task reports again. */
  waitUntil?: number;
}

/** A live update: `marked` travels as the names added since the last one. */
export type ProgressUpdate = Omit<ProgressView, 'marked'> & {
  markedAdded: string[];
};
