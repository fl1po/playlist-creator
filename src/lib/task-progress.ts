/**
 * What a running task reports about where it is (ADR-0006). The task runner
 * holds it, shows it to the task's owner only, and drops it when the task
 * ends. Lives in `lib/` so the services' web subscribers can report through
 * it without depending on `web/`.
 */
export type StepState = 'pending' | 'active' | 'done' | 'skipped' | 'error';

/**
 * The progress bars the page has a place for: the fill's current week,
 * recalculation's scan, listening time and AW breakdown. A task reports into
 * one of these; the page draws each in its own card.
 */
export const PROGRESS_BARS = ['fillCurrent', 'recalc', 'lt', 'aw'] as const;
export type ProgressBarKey = (typeof PROGRESS_BARS)[number];

export interface TaskProgress {
  /** Declare the step strip (a fill's dates); every step starts pending. */
  steps(labels: string[]): void;
  step(index: number, state: StepState): void;
  /** Show or update the bar `key`, with the text shown beside it. */
  bar(key: ProgressBarKey, value: number, total: number, text: string): void;
  clearBar(key: ProgressBarKey): void;
  /** Mark names as handled, e.g. the artists a fill has searched. */
  mark(...names: string[]): void;
}

export interface ProgressView {
  steps: Array<{ label: string; state: StepState }>;
  bars: Array<{
    key: ProgressBarKey;
    value: number;
    total: number;
    text: string;
  }>;
  marked: string[];
  /** Epoch ms a rate-limit wait ends; gone once the task reports again. */
  waitUntil?: number;
}

/** A live update: `marked` travels as the names added since the last one. */
export type ProgressUpdate = Omit<ProgressView, 'marked'> & {
  markedAdded: string[];
};
