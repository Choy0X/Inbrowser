import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock,
  MoreVertical,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import type { ScheduledTask, TaskInput } from "../lib/tasks";
import { scheduleLabel } from "../lib/tasks";
import { Tooltip } from "./Tooltip";
import { PageShell } from "./PageShell";
import { TaskFormDialog, type TaskFormState } from "./TaskFormDialog";
import { APP_NAME } from "../lib/appConfig";

interface TasksViewProps {
  tasks: ScheduledTask[];
  onRefresh: () => void;
  onCreate: (input: TaskInput) => Promise<void>;
  onUpdate: (id: string, patch: Partial<TaskInput>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRunNow: (id: string) => Promise<void>;
}

function formatRun(at?: number): string {
  if (!at) return "Never";
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TasksView({ tasks, onRefresh, onCreate, onUpdate, onDelete, onRunNow }: TasksViewProps) {
  const [form, setForm] = useState<TaskFormState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openActionsFor, setOpenActionsFor] = useState<string | null>(null);
  const lastKnown = useRef<Map<string, number>>(new Map());

  // Tasks are executed by this same tab (lib/taskRunner.ts), which updates state
  // directly, so there is nothing to poll for - just load once on open.
  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  // Notify when a task completes while the app is open.
  useEffect(() => {
    for (const task of tasks) {
      if (!task.lastRunAt) continue;
      const prev = lastKnown.current.get(task.id);
      if (prev !== undefined && prev !== task.lastRunAt) {
        const title = task.lastStatus === "ok" ? "Task complete" : "Task failed";
        const body =
          task.lastStatus === "ok"
            ? `${task.name}: ${task.lastResult?.slice(0, 120) ?? ""}`
            : `${task.name}: ${task.lastResult ?? ""}`;
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification(title, { body });
        }
      }
      lastKnown.current.set(task.id, task.lastRunAt);
    }
  }, [tasks]);

  const requestNotifications = () => {
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  };

  const openCreate = () => {
    const now = new Date();
    setForm({
      name: "",
      prompt: "",
      frequency: "daily",
      hour: now.getHours(),
      minute: now.getMinutes(),
      weekday: now.getDay(),
      enabled: true,
    });
    setError(null);
  };

  const openEdit = (task: ScheduledTask) => {
    setForm({
      id: task.id,
      name: task.name,
      prompt: task.prompt,
      frequency: task.frequency,
      hour: task.hour,
      minute: task.minute,
      weekday: task.weekday ?? 0,
      enabled: task.enabled,
    });
    setError(null);
    setOpenActionsFor(null);
  };

  const submit = async () => {
    if (!form) return;
    if (!form.name.trim() || !form.prompt.trim()) {
      setError("Name and prompt are required.");
      return;
    }
    const input: TaskInput = {
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      frequency: form.frequency,
      hour: form.hour,
      minute: form.minute,
      weekday: form.frequency === "weekly" ? form.weekday : undefined,
      enabled: form.enabled,
      model: "auto",
    };
    setBusy("form");
    try {
      if (form.id) await onUpdate(form.id, input);
      else await onCreate(input);
      setForm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (id: string) => {
    setBusy(id);
    setOpenActionsFor(null);
    try {
      await onRunNow(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setOpenActionsFor(null);
    try {
      await onDelete(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const actionsTask = tasks.find((t) => t.id === openActionsFor) ?? null;

  return (
    <PageShell
      title="Scheduled tasks"
      icon={<Clock size={24} className="shrink-0 text-accent" />}
      subtitle={`Tasks run in this browser tab, so keep ${APP_NAME} open for them to fire. Results are kept in the task history.`}
      actions={
        <button
          type="button"
          onClick={openCreate}
          className="flex h-10 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover"
        >
          <Plus size={15} /> New task
        </button>
      }
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-faint">
        <Clock size={13} />
        {tasks.length} task{tasks.length === 1 ? "" : "s"} · checked every 30 seconds while this
        tab is open
        <Tooltip label="Get browser notifications when a task finishes">
          <button
            type="button"
            onClick={requestNotifications}
            className="ml-auto rounded-md border border-border bg-canvas px-2 py-1 text-fg-dim hover:bg-bg-hover hover:text-fg"
          >
            Enable notifications
          </button>
        </Tooltip>
      </div>

      {error && (
        <div className="mt-3 flex min-w-0 items-center justify-between gap-2 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={() => setError(null)} className="shrink-0 opacity-70">
            <X size={14} />
          </button>
        </div>
      )}

      {tasks.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-border-subtle bg-bg-elevated/40 p-8 text-center">
          <Clock size={28} className="mx-auto text-fg-faint" />
          <p className="mt-2 text-sm text-fg-dim">No scheduled tasks yet.</p>
          <p className="mt-1 text-xs text-fg-faint">
            Create a task to have {APP_NAME} run it automatically — e.g. a daily briefing at 9:00.
          </p>
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {tasks.map((task) => (
            <li key={task.id} className="rounded-xl border border-border-subtle bg-bg-elevated/40">
              <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          task.enabled ? "bg-accent" : "bg-fg-faint"
                        }`}
                      />
                      <span className={`truncate text-sm font-medium ${task.enabled ? "" : "opacity-50"}`}>
                        {task.name}
                      </span>
                      {task.lastStatus === "ok" && (
                        <CheckCircle2 size={14} className="shrink-0 text-success" />
                      )}
                      {task.lastStatus === "error" && (
                        <XCircle size={14} className="shrink-0 text-error" />
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-faint">
                      <span className="flex items-center gap-1">
                        <Clock size={11} /> {scheduleLabel(task)}
                      </span>
                      <span>Last run: {formatRun(task.lastRunAt)}</span>
                      <span>Next: {formatRun(task.nextRunAt)}</span>
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-fg-dim">{task.prompt}</p>
                    {task.lastResult && (
                      <div className="mt-2 rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-xs leading-5 text-fg-dim">
                        {task.lastResult}
                      </div>
                    )}
                    {task.history && task.history.length > 0 && expanded === task.id && (
                      <div className="mt-2">
                        <ul className="space-y-1.5 rounded-lg border border-border-subtle bg-canvas px-3 py-2 text-xs leading-5 text-fg-dim">
                          {task.history.map((h, i) => (
                            <li key={i} className="flex gap-2">
                              <span className="shrink-0 text-fg-faint">{formatRun(h.at)}</span>
                              <span className={h.status === "ok" ? "text-fg-dim" : "text-error"}>
                                {h.summary}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  {/* Desktop: inline icon buttons */}
                  <div className="hidden shrink-0 items-center gap-1 md:flex">
                    <Tooltip label="Run now">
                      <button
                        type="button"
                        onClick={() => void runNow(task.id)}
                        disabled={busy === task.id}
                        className="rounded-md p-2 text-fg-dim hover:bg-bg-hover hover:text-fg disabled:opacity-40"
                      >
                        {busy === task.id ? (
                          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-fg-faint border-t-fg" />
                        ) : (
                          <Play size={15} />
                        )}
                      </button>
                    </Tooltip>
                    <Tooltip label="Edit">
                      <button
                        type="button"
                        onClick={() => openEdit(task)}
                        className="rounded-md p-2 text-fg-dim hover:bg-bg-hover hover:text-fg"
                      >
                        <Pencil size={15} />
                      </button>
                    </Tooltip>
                    <Tooltip label="Delete">
                      <button
                        type="button"
                        onClick={() => void remove(task.id)}
                        className="rounded-md p-2 text-fg-dim hover:bg-bg-hover hover:text-error"
                      >
                        <Trash2 size={15} />
                      </button>
                    </Tooltip>
                    <Tooltip label="History">
                      <button
                        type="button"
                        onClick={() => setExpanded((v) => (v === task.id ? null : task.id))}
                        className={`rounded-md p-2 text-fg-dim hover:bg-bg-hover hover:text-fg ${
                          expanded === task.id ? "text-fg" : ""
                        }`}
                      >
                        <Clock size={15} />
                      </button>
                    </Tooltip>
                  </div>

                  {/* Mobile: kebab menu */}
                  <button
                    type="button"
                    onClick={() => setOpenActionsFor(task.id)}
                    className="shrink-0 rounded-md p-2 text-fg-dim hover:bg-bg-hover hover:text-fg md:hidden"
                  >
                    <MoreVertical size={16} />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <TaskFormDialog
        open={form !== null}
        form={form}
        setForm={setForm}
        busy={busy === "form"}
        onSubmit={() => void submit()}
        onClose={() => setForm(null)}
      />

      {/* Mobile action sheet, shared across rows */}
      {actionsTask && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="absolute inset-0 bg-overlay/60" onClick={() => setOpenActionsFor(null)} />
          <div className="relative z-10 mt-auto flex w-full flex-col overflow-hidden rounded-t-2xl border-t border-border bg-bg-elevated p-3 shadow-lift">
            <div className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-[1.5px] text-fg-faint">
              {actionsTask.name}
            </div>
            <button
              type="button"
              onClick={() => void runNow(actionsTask.id)}
              disabled={busy === actionsTask.id}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Play size={16} className="shrink-0 text-accent" />
              Run now
            </button>
            <button
              type="button"
              onClick={() => openEdit(actionsTask)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium hover:bg-bg-hover"
            >
              <Pencil size={16} className="shrink-0 text-accent" />
              Edit
            </button>
            <button
              type="button"
              onClick={() => void remove(actionsTask.id)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-error hover:bg-bg-hover"
            >
              <Trash2 size={16} className="shrink-0" />
              Delete
            </button>
            <button
              type="button"
              onClick={() => {
                setExpanded((v) => (v === actionsTask.id ? null : actionsTask.id));
                setOpenActionsFor(null);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium hover:bg-bg-hover"
            >
              <Clock size={16} className="shrink-0 text-accent" />
              {expanded === actionsTask.id ? "Hide history" : "Show history"}
            </button>
          </div>
        </div>
      )}
    </PageShell>
  );
}
