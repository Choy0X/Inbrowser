import { memo, useMemo, useState } from "react";
import { ChevronRight, Wrench } from "lucide-react";
import type { AgentStep } from "../lib/agentRunner";
import { responseProxyLabel } from "../lib/gateway/responseProxy";

/** Tool results are stored untruncated by the runner; a large one must not go straight into the DOM. */
const RESULT_DISPLAY_LIMIT = 20_000;

function clip(text: string | undefined, limit: number): string {
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[${text.length - limit} more characters]`;
}

/**
 * One row of the run trace.
 *
 * Memoized because a run appends a step at a time, and without this every
 * append re-rendered every earlier row - each of them re-slicing a potentially
 * huge tool result. A 50-step run cost ~1275 row renders.
 */
export const AgentStepRow = memo(function AgentStepRow({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(false);

  const tone =
    step.kind === "error"
      ? "text-error"
      : step.kind === "answer"
        ? "text-success"
        : step.kind === "stopped"
          ? "text-warning"
          : "text-fg-dim";

  const label =
    step.kind === "tool"
      ? step.tool
      : step.kind === "answer"
        ? "Answer"
        : step.kind === "thinking"
          ? "Reasoning"
          : step.kind === "error"
            ? "Error"
            : "Stopped";

  const expandable = step.kind === "tool" || (step.text?.length ?? 0) > 220;
  const preview = useMemo(
    () => (step.kind === "tool" ? step.result ?? "" : step.text ?? "").slice(0, 140),
    [step]
  );
  const argsJson = useMemo(
    () => (open && step.args ? JSON.stringify(step.args, null, 2) : ""),
    [open, step.args]
  );
  const body = useMemo(
    () => (open ? clip(step.kind === "tool" ? step.result : step.text, RESULT_DISPLAY_LIMIT) : ""),
    [open, step]
  );

  return (
    <li className="border-b border-border-subtle last:border-0">
      {step.proxy && (
        <div className="break-all px-3 pt-2 text-[11px] text-fg-faint">
          Proxy: {responseProxyLabel(step.proxy)}
        </div>
      )}
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        className={`flex w-full items-start gap-2 px-3 py-2 text-left ${expandable ? "hover:bg-bg-hover" : "cursor-default"}`}
      >
        <span className="mt-0.5 w-5 shrink-0 text-[11px] tabular-nums text-fg-faint">{step.index + 1}</span>
        {step.depth > 0 && (
          <span className="mt-0.5 shrink-0 rounded bg-bg-hover px-1 text-[10px] text-fg-faint">
            {step.agentName}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className={`flex items-center gap-1.5 text-xs font-medium ${tone}`}>
            {step.kind === "tool" && <Wrench size={11} />}
            {label}
            {expandable && (
              <ChevronRight size={11} className={`transition-transform ${open ? "rotate-90" : ""}`} />
            )}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-fg-faint">{preview}</span>
        </span>
        <span className="mt-0.5 shrink-0 text-[11px] tabular-nums text-fg-faint">
          {Math.round(step.durationMs)}ms
        </span>
      </button>

      {open && (
        <div className="space-y-2 bg-canvas px-3 pb-3 pt-1">
          {step.args && Object.keys(step.args).length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-fg-faint">Arguments</div>
              <pre className="overflow-x-auto rounded-lg border border-border-subtle bg-bg-elevated p-2 text-[11px] leading-4">
                {argsJson}
              </pre>
            </div>
          )}
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-fg-faint">
              {step.kind === "tool" ? "Result" : "Text"}
            </div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-bg-elevated p-2 font-sans text-[11px] leading-5 text-fg-dim">
              {body}
            </pre>
          </div>
        </div>
      )}
    </li>
  );
});
