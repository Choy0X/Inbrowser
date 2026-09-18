/// <reference lib="webworker" />
import { requestInputSync } from "../lib/codeRunners/interactiveStdin";
import { bundleScript } from "../lib/codeRunners/npmModules";
import { createModuleShims, processShim } from "./moduleShims";

export {};

// Runs generated JS in a real Worker rather than the app's existing sandboxed
// preview iframe: a sandboxed srcDoc iframe is a privilege boundary, not a
// thread boundary, and typically still shares the main render thread — a
// `while(true){}` there would freeze the whole tab, Stop button included. A
// Worker gives genuine OS-thread isolation, so `worker.terminate()` is a real
// hard-stop. Brought to parity with typescriptWorker.ts: code is bundled with
// esbuild-wasm first (see npmModules.ts) so `import`/`require` of Node
// built-ins and real npm packages work here too, not just plain script.

type InMessage =
  | { kind: "run"; runId: string; code: string; interactive?: boolean; buffer?: SharedArrayBuffer }
  | { kind: "input-answer"; runId: string; value: string | null };
type OutMessage =
  | { kind: "ready"; runId: string }
  | { kind: "stdout" | "stderr"; runId: string; line: string }
  /** CDN fetch progress ("Fetching lodash@4.17.21...") - see typescriptWorker.ts. */
  | { kind: "status"; runId: string; line: string }
  | { kind: "done"; runId: string }
  | { kind: "error"; runId: string; message: string }
  | { kind: "input-request"; runId: string; prompt: string };

function post(msg: OutMessage): void {
  self.postMessage(msg);
}

/**
 * Set per-run from the "run" message, exactly like pyodideWorker.ts. Present
 * only when the caller opted into interactive stdin AND SharedArrayBuffer is
 * available (see workerRunner.ts) - absent, `input()` below returns null
 * immediately, so a run from the run_code tool call (which never opts in) is
 * completely unaffected.
 */
let currentRunId = "";
let currentInputBuffer: SharedArrayBuffer | undefined;

/**
 * Generated scripts almost always end with a fire-and-forget `main();` (no
 * top-level `await`, no `.catch`) rather than `await main()` - there is no
 * top-level-await convention to follow here, so the model writes the same
 * idiom it would for a real Node CLI script. The outer wrapper below used to
 * settle the instant its OWN synchronous body finished, which happens the
 * moment `main()` hits its first `await` and hands control back - long
 * before `main`'s own chain of awaited `input()` calls had run, so "done"
 * could fire mid-script and any question after that point got asked with
 * nobody left listening (the caller already tore down its message handler),
 * permanently wedging this worker in `Atomics.wait` on its next run.
 *
 * A single macrotask hop fixes this precisely, not just empirically: a
 * `setTimeout` callback is only ever run once the microtask queue is fully
 * drained, and `Atomics.wait` (interactiveStdin.ts) freezes the whole worker
 * thread - including this pending timer - for as long as a question is
 * outstanding. So this line cannot fire until every microtask `main()`'s
 * chain still has queued has run, and cannot fire while `main()` is blocked
 * waiting on a human, however many questions that takes.
 */
function drainOrphanedWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * An uncaught rejection from an unawaited top-level call (`main();` with no
 * `.catch`) surfaces here, not in the run's own try/catch - nothing here
 * `await`s that promise directly. Without this it is silently dropped: the
 * run already reported "done" via drainOrphanedWork() above by the time it
 * rejects, so the caller has no handler left listening for a stderr/error
 * message tied to that runId.
 */
self.addEventListener("unhandledrejection", (event) => {
  if (!currentRunId) return;
  event.preventDefault();
  const reason = event.reason;
  post({
    kind: "stderr",
    runId: currentRunId,
    line: `Uncaught (in promise) ${reason instanceof Error ? reason.message : String(reason)}`,
  });
});

/**
 * JS has no builtin blocking read - this is the equivalent this sandbox
 * offers, modeled on Python's input(): synchronous, returns the answered
 * line, or null on EOF/cancel. `requestInputSync` physically blocks this
 * worker's own thread via Atomics.wait(), never the main thread.
 */
function input(prompt?: string): string | null {
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
}

/** Node built-ins and real npm packages resolve via bundleScript (npmModules.ts); this satisfies whatever it leaves external. */
const { requireShim, resetForRun } = createModuleShims(input);

function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try {
    return JSON.stringify(arg, null, 2) ?? String(arg);
  } catch {
    return String(arg);
  }
}

function makeConsole(runId: string) {
  const line = (kind: "stdout" | "stderr", args: unknown[]) =>
    post({ kind, runId, line: args.map(stringifyArg).join(" ") });
  return {
    log: (...args: unknown[]) => line("stdout", args),
    info: (...args: unknown[]) => line("stdout", args),
    debug: (...args: unknown[]) => line("stdout", args),
    warn: (...args: unknown[]) => line("stderr", args),
    error: (...args: unknown[]) => line("stderr", args),
  };
}

self.onmessage = async (event: MessageEvent<InMessage>) => {
  if (event.data.kind !== "run") return;
  const { runId, code, interactive, buffer } = event.data;
  currentRunId = runId;
  currentInputBuffer = interactive ? buffer : undefined;
  resetForRun();
  try {
    // cjs, not esm - see typescriptWorker.ts's identical comment. bundleScript
    // rewrites imports to `require()` (external specifiers) or inlines them
    // directly (polyfilled built-ins, real npm packages from esm.sh).
    const js = await bundleScript(code, "js", (line) => post({ kind: "status", runId, line }));
    post({ kind: "ready", runId });
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      "console",
      "input",
      "require",
      "process",
      "__drainOrphanedWork",
      `"use strict"; var exports = {}; var module = { exports: exports }; return (async () => {\n${js}\n  await __drainOrphanedWork();\n})();`
    ) as (
      consoleObj: ReturnType<typeof makeConsole>,
      inputFn: typeof input,
      requireFn: typeof requireShim,
      processObj: typeof processShim,
      drain: typeof drainOrphanedWork
    ) => Promise<unknown>;
    await fn(makeConsole(runId), input, requireShim, processShim, drainOrphanedWork);
    post({ kind: "done", runId });
  } catch (err) {
    post({ kind: "error", runId, message: err instanceof Error ? err.message : String(err) });
  }
};
