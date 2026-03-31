import type { SpotifyClient } from '../lib/types.js';

export interface TaskMutex {
  readonly currentTask: string | null;
  readonly currentTaskUserId: string | null;
  setBusy(task: string, userId: string): { aborted: boolean } | null;
  setIdle(): void;
  stop(): boolean;
  checkAbort(): void;
  createAbortableClient(baseClient: SpotifyClient): SpotifyClient;
}

export function createTaskMutex(
  onStatusChange: (busy: boolean, task: string | null) => void,
): TaskMutex {
  let currentTask: string | null = null;
  let currentTaskUserId: string | null = null;
  let abortFlag: { aborted: boolean } | null = null;

  function checkAbortFlag() {
    if (abortFlag?.aborted) throw new Error('Stopped by user');
  }

  return {
    get currentTask() {
      return currentTask;
    },
    get currentTaskUserId() {
      return currentTaskUserId;
    },

    setBusy(task: string, userId: string): { aborted: boolean } | null {
      if (currentTask) return null;
      currentTask = task;
      currentTaskUserId = userId;
      abortFlag = { aborted: false };
      onStatusChange(true, task);
      return abortFlag;
    },

    setIdle() {
      currentTask = null;
      currentTaskUserId = null;
      abortFlag = null;
      onStatusChange(false, null);
    },

    stop(): boolean {
      if (!(abortFlag && currentTask)) return false;
      if (abortFlag.aborted) return false;
      abortFlag.aborted = true;
      return true;
    },

    checkAbort() {
      checkAbortFlag();
    },

    createAbortableClient(baseClient: SpotifyClient): SpotifyClient {
      const flag = abortFlag as { aborted: boolean };
      return {
        get api() {
          if (flag.aborted) throw new Error('Stopped by user');
          return baseClient.api;
        },
        refreshToken: () => {
          if (flag.aborted) throw new Error('Stopped by user');
          return baseClient.refreshToken();
        },
        recreateApi: () => {
          if (flag.aborted) throw new Error('Stopped by user');
          return baseClient.recreateApi();
        },
        runAuth: baseClient.runAuth,
      };
    },
  };
}
