import { runCompletion } from "./onniroute";
import { newId } from "./store";
import { APP_NAME } from "./appConfig";

export type TaskFrequency = "hourly" | "daily" | "weekly";

export interface TaskHistoryEntry {
  at: number;
  status: "ok" | "error";
  summary: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  frequency: TaskFrequency;
  /** Hour of day (0-23) used by daily/weekly schedules. */
  hour: number;
  /** Minute of the hour (0-59). */
  minute: number;
  /** Day of week (0=Sunday..6=Saturday) for weekly schedules. */
  weekday?: number;
  enabled: boolean;
  model?: string;
  lastRunAt?: number;
  lastStatus?: "ok" | "error";
  lastResult?: string;
  nextRunAt?: number;
  history?: TaskHistoryEntry[];
}

export type TaskInput = Omit<
  ScheduledTask,
  "id" | "lastRunAt" | "lastStatus" | "lastResult" | "nextRunAt" | "history"
>;

/** Next run time (ms epoch) for a schedule, at or after `from`. */
export function computeNextRun(
  task: Pick<ScheduledTask, "frequency" | "hour" | "minute" | "weekday">,
  from = Date.now()
): number {
  const d = new Date(from);
  d.setSeconds(0, 0);
  if (task.frequency === "hourly") {
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return d.getTime();
  }
  d.setHours(task.hour, task.minute, 0, 0);
  if (task.frequency === "daily") {
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  } else {
    const wd = task.weekday ?? 0;
    let days = (wd - d.getDay() + 7) % 7;
    if (d.getTime() <= from) days = days === 0 ? 7 : days;
    d.setDate(d.getDate() + days);
  }
  return d.getTime();
}

// Tasks are stored entirely client-side (localStorage) and executed by a
// timer running in the open app (see ./taskRunner.ts) — there is no server
// task store or unattended daemon. This is the one accepted trade-off of a
// fully stateless backend: a task only fires while the app is open in a tab.

const TASKS_KEY = "fachoy:tasks:v1";

function loadTasksSync(): ScheduledTask[] {
  try {
    const raw = localStorage.getItem(TASKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ScheduledTask[]) : [];
  } catch {
    return [];
  }
}

function saveTasksSync(tasks: ScheduledTask[]): void {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export async function fetchTasks(): Promise<ScheduledTask[]> {
  return loadTasksSync();
}

export async function createTask(input: TaskInput): Promise<ScheduledTask> {
  const task: ScheduledTask = { id: newId(), ...input, nextRunAt: computeNextRun(input) };
  const tasks = loadTasksSync();
  tasks.push(task);
  saveTasksSync(tasks);
  return task;
}

/**
 * Restore a task from a backup, keeping its original id and run history.
 * Distinct from createTask, which mints a new id for fresh input.
 */
export async function importTask(task: ScheduledTask): Promise<void> {
  const tasks = loadTasksSync();
  if (tasks.some((t) => t.id === task.id)) return;
  tasks.push({ ...task, nextRunAt: computeNextRun(task) });
  saveTasksSync(tasks);
}

export async function updateTask(id: string, patch: Partial<TaskInput>): Promise<ScheduledTask> {
  const tasks = loadTasksSync();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error("Task not found");
  const next: ScheduledTask = { ...tasks[idx], ...patch };
  next.nextRunAt = computeNextRun(next);
  tasks[idx] = next;
  saveTasksSync(tasks);
  return next;
}

export async function deleteTask(id: string): Promise<{ ok: boolean }> {
  saveTasksSync(loadTasksSync().filter((t) => t.id !== id));
  return { ok: true };
}

const inFlight = new Set<string>();

/** Actually runs a task now: calls the model, records the result, reschedules. */
export async function executeTask(task: ScheduledTask): Promise<ScheduledTask> {
  if (inFlight.has(task.id)) return task;
  inFlight.add(task.id);
  const started = Date.now();
  try {
    const result = await runCompletion({
      model: task.model || "auto",
      messages: [
        {
          role: "system",
          content:
            `You are ${APP_NAME}, a scheduled task runner. Complete the task directly, concisely and without preamble.`,
        },
        { role: "user", content: task.prompt },
      ],
      maxTokens: 768,
    });
    return applyRunResult(task.id, started, "ok", result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return applyRunResult(task.id, started, "error", message);
  } finally {
    inFlight.delete(task.id);
  }
}

function applyRunResult(id: string, startedAt: number, status: "ok" | "error", text: string): ScheduledTask {
  const tasks = loadTasksSync();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error("Task not found");
  const task = tasks[idx];
  const updated: ScheduledTask = {
    ...task,
    lastRunAt: startedAt,
    lastStatus: status,
    lastResult: text,
    nextRunAt: computeNextRun(task, Date.now()),
    history: [...(task.history ?? []), { at: startedAt, status, summary: truncate(text, 400) }].slice(-20),
  };
  tasks[idx] = updated;
  saveTasksSync(tasks);
  return updated;
}

export async function runTaskNow(id: string): Promise<ScheduledTask> {
  const task = loadTasksSync().find((t) => t.id === id);
  if (!task) throw new Error("Task not found");
  return executeTask(task);
}

/** Human-readable schedule label, e.g. "Every day at 09:00". */
export function scheduleLabel(task: Pick<ScheduledTask, "frequency" | "hour" | "minute" | "weekday">): string {
  const hh = String(task.hour).padStart(2, "0");
  const mm = String(task.minute).padStart(2, "0");
  const time = `${hh}:${mm}`;
  if (task.frequency === "hourly") return "Every hour";
  if (task.frequency === "daily") return `Every day at ${time}`;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `Every ${days[task.weekday ?? 0]} at ${time}`;
}