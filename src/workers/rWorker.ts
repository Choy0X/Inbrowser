/// <reference lib="webworker" />
import { WebR } from "webr";
import { installCacheFirstFetch } from "./runtimeCacheFetch";

/**
 * R, via webR (a WebAssembly build of the R interpreter).
 *
 * webR's own architecture doesn't fit the pattern every other runtime here
 * uses: `new WebR()` is designed to own and manage its own internal worker,
 * not be handed one this app already created and drives via postMessage.
 * Instantiating it here, inside this app's own dedicated worker, means webR
 * spawns its inner worker FROM WITHIN that outer worker (nested workers are
 * supported in evergreen browsers) - verified hands-on: it boots, evaluates,
 * and produces output correctly this way. `outerWorker.terminate()` was also
 * verified to stop the outer channel immediately (no further messages ever
 * arrive) even mid-computation; if webR's own inner worker doesn't get torn
 * down by that same terminate() call, that's an accepted resource leak, not
 * a correctness problem - an orphaned inner worker has no live channel back
 * to the main thread once the outer worker is gone, so it can't emit output
 * or affect any later run.
 *
 * Interactive input drives `WebR`'s low-level message channel directly
 * (`stream()`/`writeConsole()`) rather than the higher-level, REPL-oriented
 * `Console` helper webR also ships: Console's constructor unconditionally
 * does `document.createElement("canvas")` for plot output (verified by
 * reading its bundled source - `h || (this.canvas = document.createElement(...))`,
 * where `h` is only true under Node) with no way to opt out, and `document`
 * does not exist in a Worker - constructing a Console here throws
 * "document is not defined" immediately. The messages Console's own `run()`
 * loop reacts to (`{type:"stdout"|"stderr"|"prompt"|"canvas"|"closed"}`) come
 * from this same lower-level `webR.stream()`, so reading them here directly
 * reproduces Console's `prompt` behavior - the one thing this file actually
 * needs - without the DOM dependency. `readline()`/`scan()` inside a running
 * script pause on the exact same R_ReadConsole mechanism that drives R's
 * ordinary top-level `>` prompt between statements; this file tells the two
 * apart with a sentinel written to stdout (see DONE_MARKER/ERROR_MARKER)
 * rather than by inspecting the prompt text, since both surface identically
 * as a `"prompt"` message. This also switches R's output from "posted all at
 * once after the run finishes" to properly streamed as it happens, which is
 * a prerequisite for a human seeing prior prints before answering a prompt.
 *
 * The outer worker here can never block its own thread on a pending prompt
 * (unlike Pyodide's synchronous stdin callback): the `stream()` loop below
 * runs asynchronously on this same thread, and blocking it with Atomics.wait
 * would freeze the very loop that needs to keep running to eventually
 * deliver R's response. So this worker answers a prompt purely via the async
 * "input-answer" message workerRunner.ts sends back (see its doc comment),
 * never the SharedArrayBuffer/Atomics path every other interactive worker
 * here uses.
 */
installCacheFirstFetch("fachoy-plugin-r");

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
 * Unlikely-to-collide markers (control-character-free but "_fachoy_"-styled,
 * mirroring the identifiers other workers use for the same reason) that let
 * this worker tell "the script finished" apart from "R is showing its
 * ordinary idle `>` prompt" - both surface through the exact same `"prompt"`
 * message, so detecting completion has to happen via stdout instead of by
 * inspecting the prompt text.
 */
const DONE_MARKER = "__FACHOY_R_DONE__";
const ERROR_MARKER = "__FACHOY_R_ERROR__";

let currentRunId = "";
/** True once this run has hit its done/error marker; ignore any prompt after that until the next run. */
let runSettled = true;
let currentInteractive = false;
/** The literal prompt text from the last `"prompt"` message - readline()'s own prompt, or R's ">"/"+". */
let lastPromptText = "";

let pendingAnswer: ((value: string | null) => void) | null = null;

let webRPromise: Promise<WebR> | null = null;
function getWebR(): Promise<WebR> {
  if (!webRPromise) {
    webRPromise = new Promise<WebR>((resolveBooted) => {
      void (async () => {
        const webR = new WebR({ baseUrl: "/r/" });
        await webR.init();
        // await webR.init() resolves before R has actually finished booting -
        // its startup banner and first idle ">" prompt still stream out
        // asynchronously afterward (verified hands-on: without this, that
        // banner text landed inside the FIRST real run's own output, since
        // currentRunId was already set by the time it arrived). Don't hand
        // back a usable WebR - and don't let the caller start a run - until
        // that first prompt has actually been observed; onOutput/onPrompt
        // both no-op on it regardless since currentRunId is still empty then.
        void readLoop(webR, () => resolveBooted(webR));
      })();
    });
  }
  return webRPromise;
}

/** Mirrors Console's own `run()` loop (see the header comment), minus canvas handling. */
async function readLoop(webR: WebR, onFirstPrompt: () => void): Promise<void> {
  let booted = false;
  for await (const msg of webR.stream()) {
    if (msg.type === "stdout") onOutput("stdout", String(msg.data));
    else if (msg.type === "stderr") onOutput("stderr", String(msg.data));
    else if (msg.type === "prompt") {
      if (!booted) {
        booted = true;
        onFirstPrompt();
      }
      lastPromptText = String(msg.data ?? "");
      onPrompt(webR);
    } else if (msg.type === "closed") return;
    // "canvas" (plot output) and anything else: no rendering surface in a
    // worker with no DOM, so there is nothing useful to do with it here.
  }
}

function onOutput(kind: "stdout" | "stderr", line: string): void {
  if (!currentRunId || runSettled) return;
  if (line === DONE_MARKER) {
    runSettled = true;
    post({ kind: "done", runId: currentRunId });
    return;
  }
  if (line.startsWith(ERROR_MARKER)) {
    runSettled = true;
    post({ kind: "error", runId: currentRunId, message: line.slice(ERROR_MARKER.length) });
    return;
  }
  post({ kind, runId: currentRunId, line });
}

/**
 * Fires whenever R needs another line of input it doesn't already have
 * buffered - both for a genuine `readline()`/`scan()` call inside a running
 * script, and for R's own idle `>` prompt before the first run and after each
 * one finishes (see the header comment). Only the former should ever reach a
 * human: once a run has settled (or none is active), this is a dangling idle
 * prompt that the next run's own `writeConsole()` call will transparently
 * satisfy, so it's simply left unanswered here.
 */
function onPrompt(webR: WebR): void {
  if (!currentRunId || runSettled) return;
  if (!currentInteractive) {
    // No human is driving this run (e.g. a run_code tool call, which never
    // supplies onInputRequest) - answer with an empty line immediately,
    // mirroring every other runtime's immediate-EOF fallback rather than
    // leaving the script hanging forever on an unanswered prompt.
    webR.writeConsole("");
    return;
  }
  post({ kind: "input-request", runId: currentRunId, prompt: lastPromptText });
  pendingAnswer = (value) => {
    // R has no clean "closed stdin" signal to feed readline() the way
    // Python's EOFError does - an empty line is the closest equivalent.
    webR.writeConsole(value ?? "");
  };
}

self.onmessage = async (event: MessageEvent<InMessage>) => {
  if (event.data.kind === "input-answer") {
    if (event.data.runId !== currentRunId) return; // stale - a prior run's late answer
    pendingAnswer?.(event.data.value);
    pendingAnswer = null;
    return;
  }
  if (event.data.kind !== "run") return;
  const { runId, code, interactive } = event.data;
  try {
    const webR = await getWebR();
    currentRunId = runId;
    runSettled = false;
    currentInteractive = Boolean(interactive);
    post({ kind: "ready", runId });
    // A single balanced multi-line expression, not one line per statement:
    // R's REPL parser buffers continuation lines until the whole tryCatch()
    // call is syntactically complete, so readline() calls anywhere inside the
    // user's code pause mid-evaluation exactly as they would in a real
    // interactive session, and one error handler still reports an uncaught
    // exception the same way every other runtime's single try/catch does.
    // The handler's parameter is dot-prefixed, not underscore-prefixed: R
    // identifiers cannot start with "_" (verified hands-on - it's a genuine
    // parse error, "unexpected input", not just a style nit), so
    // "__fachoy_e" broke every run here; ".fachoy_e" mirrors the same
    // dot-prefixed convention this file's old capture.output wrapper already
    // used for its own scratch variable.
    const wrapped =
      `tryCatch({\n${code}\n}, error = function(.fachoy_e) ` +
      `cat("${ERROR_MARKER}", conditionMessage(.fachoy_e), "\\n", sep = ""))\n` +
      `cat("${DONE_MARKER}\\n")\n`;
    webR.writeConsole(wrapped);
  } catch (err) {
    post({ kind: "error", runId, message: err instanceof Error ? err.message : String(err) });
  }
};
