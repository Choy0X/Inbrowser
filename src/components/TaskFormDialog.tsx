import type { TaskFrequency } from "../lib/tasks";
import { Dialog } from "./Dialog";
import { Toggle } from "./Toggle";
import { Input, Select, Textarea } from "./ui";

export interface TaskFormState {
  id?: string;
  name: string;
  prompt: string;
  frequency: TaskFrequency;
  hour: number;
  minute: number;
  weekday: number;
  enabled: boolean;
}

const FREQUENCIES: { value: TaskFrequency; label: string }[] = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function timeString(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function TaskFormDialog({
  open,
  form,
  setForm,
  busy,
  onSubmit,
  onClose,
}: {
  open: boolean;
  form: TaskFormState | null;
  setForm: (updater: (f: TaskFormState | null) => TaskFormState | null) => void;
  busy: boolean;
  onSubmit: () => void;
  onClose: () => void;
}) {
  if (!form) return null;

  return (
    <Dialog open={open} onClose={onClose} title={form.id ? "Edit task" : "New task"}>
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-fg-dim" htmlFor="task-name">
            Name
          </label>
          <Input
            id="task-name"
            value={form.name}
            onChange={(e) => setForm((f) => (f ? { ...f, name: e.target.value } : f))}
            placeholder="e.g. Morning briefing"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-fg-dim" htmlFor="task-prompt">
            What should it do?
          </label>
          <Textarea
            id="task-prompt"
            value={form.prompt}
            onChange={(e) => setForm((f) => (f ? { ...f, prompt: e.target.value } : f))}
            rows={3}
            placeholder="e.g. Summarize today's to-dos from your saved notes and suggest a priority order."
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-fg-dim" htmlFor="task-freq">
              Frequency
            </label>
            <Select
              id="task-freq"
              value={form.frequency}
              onChange={(e) =>
                setForm((f) => (f ? { ...f, frequency: e.target.value as TaskFrequency } : f))
              }
            >
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
          </div>
          {form.frequency !== "hourly" && (
            <div>
              <label className="mb-1 block text-xs font-medium text-fg-dim" htmlFor="task-time">
                Time
              </label>
              <Input
                id="task-time"
                type="time"
                value={timeString(form.hour, form.minute)}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(":").map(Number);
                  setForm((f) => (f && !Number.isNaN(h) && !Number.isNaN(m) ? { ...f, hour: h, minute: m } : f));
                }}
              />
            </div>
          )}
          {form.frequency === "weekly" && (
            <div>
              <label className="mb-1 block text-xs font-medium text-fg-dim" htmlFor="task-weekday">
                Day
              </label>
              <Select
                id="task-weekday"
                value={form.weekday}
                onChange={(e) => setForm((f) => (f ? { ...f, weekday: Number(e.target.value) } : f))}
              >
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="flex items-center">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-fg-dim">
              <Toggle
                checked={form.enabled}
                onChange={(next) => setForm((f) => (f ? { ...f, enabled: next } : f))}
              />
              Enabled
            </label>
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm text-fg-dim hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            {busy ? "Saving…" : form.id ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
