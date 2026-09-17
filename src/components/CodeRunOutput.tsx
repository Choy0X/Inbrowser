import { useEffect, useRef, useState } from "react";
import { CircleCheck, CircleX, Loader2, Square } from "lucide-react";

export type RunStatus = "loading" | "running" | "success" | "error" | "aborted";

export interface RunLine {
  /** "status" is the runtime talking about itself (downloading a package),
   *  not the program's own output - rendered dim so the two can't be confused. */
  stream: "stdout" | "stderr" | "status";
  text: string;
}

function StatusBadge({ status }: { status: RunStatus }) {
  if (status === "loading") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-fg-faint">
        <Loader2 size={12} className="animate-spin" /> Loading runtime…
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-accent">
        <Loader2 size={12} className="animate-spin" /> Running…
      </span>
    );
  }
  if (status === "success") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-success">
        <CircleCheck size={12} /> Finished
      </span>
    );
  }
  if (status === "aborted") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-amber">
        <Square size={11} /> Stopped
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-error">
      <CircleX size={12} /> Error
    </span>
  );
}

function InputPrompt({
  prompt,
  onSubmit,
  onCancel,
}: {
  /** input()'s own prompt text (e.g. "Enter a city name: "), captured directly
   *  from Python - "" if the script called input() with no argument. */
  prompt: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focused as soon as it appears - the program is blocked waiting right now.
  useEffect(() => inputRef.current?.focus(), []);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
      className="flex shrink-0 items-center gap-2 border-t border-on-night/10 bg-on-night/5 px-3 py-1.5"
    >
      {/* input() already writes its own prompt to stdout (CPython does this
       *  itself before blocking) - it's already visible in the log above, so
       *  showing it again here as a separate label would just duplicate it.
       *  Using it as the field's placeholder instead answers "what does it
       *  want" without a second copy of the same text to keep aligned. */}
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        placeholder={prompt.trim() || "Type your answer…"}
        className="min-w-0 flex-1 rounded border border-on-night/15 bg-transparent px-2 py-1 font-mono text-[12px] leading-5 text-on-night placeholder:text-on-night-soft focus:border-accent/50 focus:outline-none"
      />
      <button
        type="submit"
        className="rounded-md border border-on-night/15 px-2 py-1 text-[11px] font-medium text-on-night-soft transition-colors hover:bg-on-night/10 hover:text-on-night"
      >
        Enter
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-on-night/15 px-2 py-1 text-[11px] font-medium text-on-night-soft transition-colors hover:bg-on-night/10 hover:text-on-night"
      >
        Cancel
      </button>
    </form>
  );
}

export function CodeRunOutput({
  status,
  lines,
  onStop,
  inputPrompt = null,
  onSubmitInput,
  onCancelInput,
}: {
  status: RunStatus;
  lines: RunLine[];
  onStop: () => void;
  /** The program called input() and is blocked waiting for a line of text -
   *  the exact prompt string passed to input() ("" if none was given), or
   *  null when not currently awaiting input. Only ever set when
   *  SharedArrayBuffer/cross-origin isolation is available; see
   *  workerRunner.ts and interactiveStdin.ts. */
  inputPrompt?: string | null;
  onSubmitInput?: (value: string) => void;
  onCancelInput?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, inputPrompt]);

  const busy = status === "loading" || status === "running";

  return (
    <div className="flex h-48 shrink-0 flex-col border-t border-border-subtle bg-night text-on-night">
      <div className="flex shrink-0 items-center justify-between border-b border-on-night/10 px-3 py-1.5">
        <StatusBadge status={status} />
        {busy && (
          <button
            type="button"
            onClick={onStop}
            className="flex items-center gap-1 rounded-md border border-on-night/15 px-2 py-1 text-[11px] font-medium text-on-night-soft transition-colors hover:bg-on-night/10 hover:text-on-night"
          >
            <Square size={10} /> Stop
          </button>
        )}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-5">
        {lines.length === 0 ? (
          <p className="text-on-night-soft">Waiting for output…</p>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              className={`whitespace-pre-wrap break-words ${
                line.stream === "stderr"
                  ? "text-error"
                  : line.stream === "status"
                    ? "text-on-night-soft"
                    : "text-on-night"
              }`}
            >
              {line.text}
            </div>
          ))
        )}
      </div>
      {inputPrompt !== null && onSubmitInput && onCancelInput && (
        <InputPrompt prompt={inputPrompt} onSubmit={onSubmitInput} onCancel={onCancelInput} />
      )}
    </div>
  );
}
