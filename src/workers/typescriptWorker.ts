import { requestInputSync } from "../lib/codeRunners/interactiveStdin";
import { bundleScript } from "../lib/codeRunners/npmModules";
import { createModuleShims, processShim } from "./moduleShims";

/**
 * TypeScript, bundled with esbuild-wasm and then executed in this worker.
 *
 * Transpile-only as far as types go: they're erased, never checked. That is
 * the honest scope - a full type check needs the TypeScript compiler, which is
 * an order of magnitude larger, and the point here is to run a generated
 * snippet. Module resolution, unlike types, is real: `bundleScript` (see
 * npmModules.ts) resolves Node built-ins and real npm packages (fetched from
 * esm.sh) into the one output bundle below.
 *
 * Execution mirrors jsRunnerWorker: `new Function` with an injected console.
 *
 * Evaluating arbitrary source is the whole feature here, not an oversight - the
 * user asked for this snippet to run. What makes it safe enough is the
 * boundary, not the parser: this is a module Worker with no DOM, no access to
 * app state, and its own thread, so a runaway or hostile program can be killed
 * outright with `terminate()`. Do not lift this pattern into the main thread.
 */

type InMessage =
  | { kind: "run"; runId: string; code: string; interactive?: boolean; buffer?: SharedArrayBuffer }
  | { kind: "input-answer"; runId: string; value: string | null };
type OutMessage =
  | { kind: "ready"; runId: string }
  | { kind: "stdout" | "stderr"; runId: string; line: string }
  /** CDN fetch progress ("Fetching lodash@4.17.21...") - neither the program's
   *  output nor an error, mirrors pyodideWorker.ts's loader chatter. */
  | { kind: "status"; runId: string; line: string }
  | { kind: "done"; runId: string }
  | { kind: "error"; runId: string; message: string }
  | { kind: "input-request"; runId: string; prompt: string };

function post(msg: OutMessage): void {
  (self as unknown as Worker).postMessage(msg);
}

/** Set per-run; see jsRunnerWorker.ts's identical fields for the full story. */
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

/** Same synchronous `input()` sandbox global as jsRunnerWorker.ts. */
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

/**
 * Node built-ins and real npm packages both resolve now (see npmModules.ts);
 * `require()` for anything left `external` by that bundling step - readline,
 * process, fs, http/https - is satisfied here. `resetForRun` clears the
 * ephemeral `fs` shim's contents so they don't leak from one run into the
 * next in a warm, reused worker.
 */
const { requireShim, resetForRun } = createModuleShims(input);

function format(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function makeConsole(runId: string) {
  const write = (stream: "stdout" | "stderr", args: unknown[]) =>
    post({ kind: stream, runId, line: args.map(format).join(" ") });
  return {
    log: (...a: unknown[]) => write("stdout", a),
    info: (...a: unknown[]) => write("stdout", a),
    debug: (...a: unknown[]) => write("stdout", a),
    warn: (...a: unknown[]) => write("stderr", a),
    error: (...a: unknown[]) => write("stderr", a),
  };
}

self.onmessage = async (event: MessageEvent<InMessage>) => {
  if (event.data.kind !== "run") return;
  const { runId, code, interactive, buffer } = event.data;
  currentRunId = runId;
  currentInputBuffer = interactive ? buffer : undefined;
  resetForRun();

  try {
    // cjs, not esm: this runs inside `new Function`, a plain function body,
    // not a module - a top-level `import`/`export` there is a SyntaxError
    // ("Cannot use import statement outside a module"). bundleScript's cjs
    // output rewrites imports to `require()` calls (for anything left
    // external) or inlines them directly (Node built-ins with a polyfill, and
    // real npm packages fetched from esm.sh) - see npmModules.ts.
    const js = await bundleScript(code, "ts", (line) => post({ kind: "status", runId, line }));
    post({ kind: "ready", runId });

    const fn = new Function(
      "console",
      "input",
      "require",
      "process",
      "__drainOrphanedWork",
      `"use strict"; var exports = {}; var module = { exports: exports }; return (async () => {\n${js}\n  await __drainOrphanedWork();\n})();`
    ) as (
      c: ReturnType<typeof makeConsole>,
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
