import { executeTask, fetchTasks } from "./tasks";

const POLL_INTERVAL_MS = 30_000;

/**
 * Client-side scheduler: while the app is open, checks for due/enabled tasks
 * on an interval and fires them (see ./tasks.ts's executeTask). There is no
 * server-side daemon — tasks only run while a tab has this mounted. Returns
 * a cleanup function that stops the timer.
 */
export function startTaskScheduler(onChange?: () => void): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const tasks = await fetchTasks();
    const now = Date.now();
    const due = tasks.filter((t) => t.enabled && (t.nextRunAt ?? 0) <= now);
    for (const task of due) {
      await executeTask(task);
      onChange?.();
    }
  };

  const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
  void tick();

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
