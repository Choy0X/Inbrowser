/** Streamed callbacks a runner reports back to the UI while a run is in flight. */
export interface RunCallbacks {
  /** Runtime finished loading and the code itself is now executing. */
  onReady?: () => void;
  onStdout: (line: string) => void;
  onStderr: (line: string) => void;
  /**
   * The runtime saying what it is doing, rather than the program saying
   * anything - Pyodide's "Loading numpy, pandas" while it downloads wheels is
   * the case this exists for. Kept off stdout because a caller renders that as
   * the program's own output, and off stderr because none of this is a failure.
   * Optional: a runner that never reports progress simply never calls it.
   */
  onStatus?: (line: string) => void;
  /**
   * The running program called input(prompt) and is waiting for a line of
   * text - `prompt` is the exact string passed to input() (captured directly
   * from Python via a stdin-adjacent monkeypatch, not scraped from stdout, so
   * it's available immediately and reliably; may be "" if the script called
   * input() with no prompt). Only a caller driven by a human (the artifact
   * panel's manual "Run") should ever provide this - it requires
   * SharedArrayBuffer (cross-origin isolation) to actually pause the worker,
   * so a runner silently falls back to the existing immediate-EOF behavior
   * when that isn't available. Resolving with null gives up (same as EOF).
   * Never provided by the run_code tool call: there is no UI surface to
   * prompt anyone mid-tool-call, and the model's turn is bounded by a short
   * timeout - pausing it would turn today's fast, clear failure into a hang.
   */
  onInputRequest?: (prompt: string) => Promise<string | null>;
  signal: AbortSignal;
}

export type RunOutcome =
  | { kind: "success" }
  | { kind: "error"; message: string }
  | { kind: "aborted" };

export const DEFAULT_RUN_TIMEOUT_MS = 20_000;

/** One language runtime, backed by a dedicated Worker for real thread isolation. */
export interface CodeRunner {
  matches(language: string | undefined): boolean;
  run(code: string, callbacks: RunCallbacks): Promise<RunOutcome>;
  /** Force-terminates any in-flight run and its worker. Safe to call when idle. */
  dispose(): void;
}
