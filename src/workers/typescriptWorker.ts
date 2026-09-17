import * as esbuild from "esbuild-wasm";
import wasmUrl from "esbuild-wasm/esbuild.wasm?url";
import { requestInputSync } from "../lib/codeRunners/interactiveStdin";

/**
 * TypeScript, transpiled with esbuild-wasm and then executed in this worker.
 *
 * Transpile-only: types are erased, never checked. That is the honest scope -
 * a full type check needs the TypeScript compiler, which is an order of
 * magnitude larger, and the point here is to run a generated snippet.
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
 * Models write idiomatic Node CLI scripts - `import * as readline from
 * "readline"` then `rl.question(...)` - because they don't know this sandbox
 * already exposes `input()` directly. Rather than fail those scripts outright,
 * `readline`'s `createInterface().question` is shimmed on top of the same
 * synchronous `input()` above; `readline/promises` gets the Promise-returning
 * variant. There is no other module resolution - `require()` throws a message
 * pointing back at `input()`/`console` for anything else, instead of letting a
 * bare specifier crash as a confusing ReferenceError deep in generated code.
 */
const READLINE_SPECIFIERS = new Set(["readline", "node:readline"]);
const READLINE_PROMISES_SPECIFIERS = new Set(["readline/promises", "node:readline/promises"]);

function makeReadlineShim(promisesApi: boolean) {
  return {
    createInterface: () =>
      promisesApi
        ? {
            question: (query?: string) => Promise.resolve(input(query) ?? ""),
            close: () => {},
          }
        : {
            question: (query: string | undefined, callback: (answer: string) => void) =>
              callback(input(query) ?? ""),
            close: () => {},
          },
  };
}

function requireShim(specifier: string): unknown {
  if (READLINE_SPECIFIERS.has(specifier)) return makeReadlineShim(false);
  if (READLINE_PROMISES_SPECIFIERS.has(specifier)) return makeReadlineShim(true);
  throw new Error(
    `Cannot import "${specifier}": this sandbox has no npm or Node module resolution. Only "readline" is ` +
      `shimmed (backed by input()) - call input()/console directly instead of importing anything else.`
  );
}

/** Enough of Node's `process` that `readline.createInterface({ input: process.stdin, ... })` doesn't throw a bare ReferenceError; the shim above ignores the values. */
const processShim = { stdin: {}, stdout: {}, argv: [], env: {} };

let ready: Promise<void> | null = null;
function initEsbuild(): Promise<void> {
  if (!ready) ready = esbuild.initialize({ wasmURL: wasmUrl, worker: false });
  return ready;
}

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

  try {
    await initEsbuild();
    // cjs, not esm: this runs inside `new Function`, a plain function body,
    // not a module - a top-level `import`/`export` there is a SyntaxError
    // ("Cannot use import statement outside a module"), which esbuild's
    // transform never strips because transform() only rewrites syntax, it
    // never resolves or bundles modules. cjs format rewrites imports to
    // `require()` calls instead, which we can actually satisfy ourselves.
    const { code: js } = await esbuild.transform(code, {
      loader: "ts",
      format: "cjs",
      target: "es2022",
    });
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
