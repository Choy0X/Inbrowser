/// <reference lib="webworker" />
import scittleSource from "scittle/dist/scittle.js?raw";
import { requestInputSync } from "../lib/codeRunners/interactiveStdin";

/**
 * Clojure, via Scittle (babashka's SCI-based ClojureScript interpreter).
 *
 * scittle ships no ESM entry point at all (confirmed: its package.json has no
 * main/module/exports) - only a prebuilt, <script>-tag-only global-attaching
 * bundle meant for a real DOM page. `?raw` pulls that file in as plain text at
 * build time (bundled into this worker's own chunk, no runtime fetch, no
 * Vite/Rollup attempt to parse it as a module), and `new Function(source)()`
 * executes it with no explicit receiver - which runs in sloppy mode, where a
 * bare top-level `this` resolves to the global object (`self` here) the way
 * scittle's IIFE build expects, sidestepping the "`this` is undefined" trap a
 * dynamic `import()` of the same non-ESM file could hit under strict module
 * scoping.
 */
new Function(scittleSource)();

export {};

type InMessage =
  | { kind: "run"; runId: string; code: string; interactive?: boolean; buffer?: SharedArrayBuffer }
  | { kind: "input-answer"; runId: string; value: string | null };
type OutMessage =
  | { kind: "ready"; runId: string }
  | { kind: "stdout" | "stderr"; runId: string; line: string }
  | { kind: "done"; runId: string }
  | { kind: "error"; runId: string; message: string }
  | { kind: "input-request"; runId: string; prompt: string };

function post(msg: OutMessage): void {
  (self as unknown as Worker).postMessage(msg);
}

/**
 * scittle has no natural per-run "engine" to create/dispose (unlike Lua's
 * fresh LuaFactory().createEngine() per run) - it evaluates against one
 * shared, persistent SCI namespace attached to this worker for its whole
 * lifetime. That means defs/vars from a prior run are visible to the next
 * one on the same warm worker, REPL-style. Accepted deliberately rather than
 * force-respawning the worker every run; revisit only if it becomes a real
 * problem in practice.
 */
let currentRunId = "";
let currentInputBuffer: SharedArrayBuffer | undefined;

/**
 * Bound on `self` so Clojure code can call it via `(js/fachoyInput "prompt")`
 * - scittle interprets ClojureScript, and `js/name` is its normal interop
 * syntax for reaching a global. Same synchronous Atomics protocol as every
 * other in-thread runtime here; see interactiveStdin.ts.
 */
(self as unknown as { fachoyInput: (prompt?: string) => string | null }).fachoyInput = (prompt?: string) => {
  if (!currentInputBuffer) return null;
  post({ kind: "input-request", runId: currentRunId, prompt: prompt ?? "" });
  try {
    return requestInputSync(currentInputBuffer);
  } catch (err) {
    post({
      kind: "stderr",
      runId: currentRunId,
      line: `[interactive input] reading the answer failed (${err instanceof Error ? err.message : String(err)}); treating as EOF.`,
    });
    return null;
  }
};

// console.log/error is the safe, verified-working bet for routing print
// output: browser-hosted SCI/ClojureScript setups route println/prn through
// it by default. Overridden once the real engine has loaded (below), so any
// of scittle's own boot-time diagnostics print through the native console
// first rather than being captured under an empty runId.
type Scittle = { core: { eval_string: (code: string) => unknown } };
const scittle = (self as unknown as { scittle: Scittle }).scittle;

const nativeLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  if (currentRunId) post({ kind: "stdout", runId: currentRunId, line });
  else nativeLog(...args);
};
console.error = console.warn = (...args: unknown[]) => {
  const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  if (currentRunId) post({ kind: "stderr", runId: currentRunId, line });
};

self.onmessage = (event: MessageEvent<InMessage>) => {
  if (event.data.kind !== "run") return;
  const { runId, code, interactive, buffer } = event.data;
  currentRunId = runId;
  currentInputBuffer = interactive ? buffer : undefined;
  try {
    post({ kind: "ready", runId });
    scittle.core.eval_string(code);
    post({ kind: "done", runId });
  } catch (err) {
    post({ kind: "error", runId, message: err instanceof Error ? err.message : String(err) });
  }
};
