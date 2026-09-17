/// <reference lib="webworker" />
import { loadPyodide, type PyodideInterface } from "pyodide";
import { requestInputSync } from "../lib/codeRunners/interactiveStdin";
import { PYODIDE_PACKAGE_BASE_URL } from "../lib/python/packages";
import { installCacheFirstFetch } from "./runtimeCacheFetch";

export {};

// Gives Pyodide's own internal asset-loading fetches (the .wasm binary,
// python_stdlib.zip, pyodide-lock.json, …) a chance to hit the Cache Storage
// bucket populated by pythonPlugin.install() - see runtimeCacheFetch.ts.
// It caches any successful GET opportunistically, which is also what makes a
// package wheel downloaded on one run available offline on the next.
installCacheFirstFetch("fachoy-plugin-python");

type InMessage = { kind: "run"; runId: string; code: string; interactive?: boolean; buffer?: SharedArrayBuffer };
type OutMessage =
  | { kind: "ready"; runId: string }
  | { kind: "stdout" | "stderr"; runId: string; line: string }
  /** Loader chatter ("Loading numpy, pandas") - neither the program's output
   *  nor an error, and rendered dim so it can't be mistaken for either. */
  | { kind: "status"; runId: string; line: string }
  | { kind: "done"; runId: string }
  | { kind: "error"; runId: string; message: string }
  | { kind: "input-request"; runId: string; prompt: string };

function post(msg: OutMessage): void {
  self.postMessage(msg);
}

let pyodidePromise: Promise<PyodideInterface> | null = null;
/**
 * Pyodide is booted once and its stdout/stderr handlers are installed then, so
 * they must read the *current* run's id rather than close over the first one.
 * They previously captured it, which meant a second Run on the same artifact
 * posted output tagged with run 1, and the runner dropped it as stale - the
 * program worked but printed nothing.
 */
let currentRunId = "";

/**
 * Set per-run by onmessage below. Present only when the caller opted into
 * interactive stdin AND SharedArrayBuffer is available (see workerRunner.ts) -
 * absent, the stdin callback below returns null immediately exactly as it
 * always has, so a run from the run_code tool call (which never opts in) or
 * on a host without cross-origin isolation is completely unaffected.
 */
let currentInputBuffer: SharedArrayBuffer | undefined;

/**
 * input()'s own prompt text ("Enter a city name: ") is written to stdout by
 * CPython itself before it blocks on stdin - but relying on scraping it back
 * out of the stdout stream would depend on Pyodide's internal line-buffering/
 * flush timing relative to when our stdin callback fires, which isn't
 * documented or guaranteed. INPUT_PROMPT_CAPTURE_PY below instead hands the
 * prompt to JS directly and synchronously, decoupled from stdout entirely, so
 * the UI can show the real question instead of a generic placeholder.
 */
let lastInputPrompt = "";

/**
 * Monkeypatches builtins.input to report its `prompt` argument to JS via
 * _fachoy_capture_prompt (registered on pyodide.globals in getPyodide below)
 * before delegating to the real input() - which still does everything it
 * always did, including writing the prompt to stdout itself. Installed once,
 * unconditionally, at boot: harmless and unused for a non-interactive run
 * (nothing reads `lastInputPrompt` unless a script actually calls input()
 * while `currentInputBuffer` is set), so there's no need to track this
 * separately from `networkPatched`'s lazy-and-sticky pattern.
 */
const INPUT_PROMPT_CAPTURE_PY = `
import builtins as _fachoy_builtins

_fachoy_orig_input = _fachoy_builtins.input

def _fachoy_input(prompt=""):
    _fachoy_capture_prompt(prompt)
    return _fachoy_orig_input(prompt)

_fachoy_builtins.input = _fachoy_input
del _fachoy_builtins
`;

/**
 * Pyodide ships no network stack by default - urllib/requests calls fail
 * with a bare OSError. Patched lazily (mirroring the loadPackagesFromImports
 * best-effort sniff below) rather than at boot, since most runs never touch
 * the network and paying an install cost on every boot would regress those.
 * Sticks for the worker's life once it succeeds; a failure is retried on the
 * next run rather than given up on permanently.
 */
let networkPatched = false;
const NETWORK_IMPORT_RE = /\b(import\s+requests|from\s+requests|import\s+urllib(?:\.request)?|from\s+urllib)\b/;
function needsNetworkPatch(code: string): boolean {
  return NETWORK_IMPORT_RE.test(code);
}

/**
 * pyodide-http, requests and their dependencies are all packages Pyodide
 * itself vendors (prebuilt for this exact Python/ABI), so no PyPI/micropip
 * round trip is needed - `loadPackage` resolves them by name against
 * `packageBaseUrl` and walks their `depends` graph itself.
 *
 * This used to read the local lock file, walk that graph by hand and build
 * jsdelivr URLs itself, because `packageBaseUrl` still defaulted to
 * "/pyodide/" - which ships no .whl files, so a bare name-based load 404'd.
 * Setting `packageBaseUrl` at boot (see getPyodide below) fixes that for every
 * package rather than for these two, and made all of that machinery redundant.
 */
const NETWORK_PATCH_PY = `
import pyodide_js as _fachoy_pjs

async def _fachoy_install_network():
    await _fachoy_pjs.loadPackage(["pyodide-http", "requests"])

    import pyodide_http
    pyodide_http.patch_all()

await _fachoy_install_network()
`;

async function getPyodide(): Promise<PyodideInterface> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      const pyodide = await loadPyodide({
        indexURL: "/pyodide/",
        // The core runtime stays self-hosted and offline-capable; only the
        // wheels, which this app deliberately does not ship, resolve to the
        // CDN. Without this, `packageBaseUrl` defaults to the directory of the
        // lock file ("/pyodide/") and every `import pandas` 404s - see
        // lib/python/packages.ts for why this is safe.
        packageBaseUrl: PYODIDE_PACKAGE_BASE_URL,
        stdout: (line: string) => post({ kind: "stdout", runId: currentRunId, line }),
        stderr: (line: string) => post({ kind: "stderr", runId: currentRunId, line }),
        // Called synchronously by the WASM runtime mid-execution - there is no
        // way to `await` a human's answer inside it. When a run is interactive
        // (currentInputBuffer set - only the manually-clicked "Run" button ever
        // opts in, and only when SharedArrayBuffer is available), this blocks
        // the whole worker thread via Atomics.wait() until the main thread
        // writes an answer, which is exactly what lets a real human answer
        // input() live. Otherwise - no interactivity requested, or no
        // SharedArrayBuffer on this host - null signals immediate EOF, the same
        // thing real CPython sees when stdin is closed, so input() raises the
        // standard `EOFError: EOF when reading a line` instead of falling
        // through to Pyodide's generic unconfigured-stream `OSError: [Errno
        // 29]`, which looks identical to (and was once mistaken for) a network
        // failure.
        stdin: () => {
          if (!currentInputBuffer) return null;
          post({ kind: "input-request", runId: currentRunId, prompt: lastInputPrompt });
          try {
            return requestInputSync(currentInputBuffer);
          } catch (err) {
            // If Atomics.wait/notify ever throws here (buffer state corrupted
            // by an overlapping run, a browser-specific restriction, etc.),
            // letting it propagate uncaught back across the WASM boundary is
            // exactly what produced the misleading, unconfigured-stream-style
            // `OSError: [Errno 29]` this whole interactive feature was meant to
            // avoid - report the real cause instead and fail as a clean EOF.
            post({
              kind: "stderr",
              runId: currentRunId,
              line: `[interactive input] reading the answer failed (${err instanceof Error ? err.message : String(err)}); treating as EOF.`,
            });
            return null;
          }
        },
      });
      pyodide.globals.set("_fachoy_capture_prompt", (p: unknown) => {
        lastInputPrompt = typeof p === "string" ? p : String(p ?? "");
      });
      await pyodide.runPythonAsync(INPUT_PROMPT_CAPTURE_PY);
      return pyodide;
    })();
  }
  return pyodidePromise;
}

self.onmessage = async (event: MessageEvent<InMessage>) => {
  const { kind, runId, code, interactive, buffer } = event.data;
  if (kind !== "run") return;
  currentRunId = runId;
  currentInputBuffer = interactive ? buffer : undefined;
  try {
    const pyodide = await getPyodide();
    post({ kind: "ready", runId });
    // Resolves the imports in `code` against the lock file and downloads
    // whatever is missing (cached by runtimeCacheFetch after the first run).
    //
    // The callbacks are the only way to see what happened: loadPackagesFromImports
    // catches each package's download failure internally and writes it straight
    // to stderr, so it does not reject and the `try/catch` that used to wrap
    // this never fired. That is how a raw "Failed to fetch" reached the UI with
    // no explanation. Messages are routed to the status stream so loader
    // chatter can't be mistaken for the program's own output.
    try {
      await pyodide.loadPackagesFromImports(code, {
        messageCallback: (line) => post({ kind: "status", runId, line }),
        errorCallback: (line) => post({ kind: "status", runId, line }),
      });
    } catch (err) {
      post({
        kind: "status",
        runId,
        line: `Could not prepare packages (${err instanceof Error ? err.message : String(err)}); continuing.`,
      });
    }
    if (!networkPatched && needsNetworkPatch(code)) {
      try {
        await pyodide.runPythonAsync(NETWORK_PATCH_PY);
        networkPatched = true;
      } catch (err) {
        post({
          kind: "stderr",
          runId,
          line: `[network setup] could not install network support (${err instanceof Error ? err.message : String(err)}); continuing without it.`,
        });
      }
    }
    await pyodide.runPythonAsync(code);
    post({ kind: "done", runId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // sys.exit()/argparse's own error handling raises SystemExit - a normal
    // program termination, not a bug. Reported like any other uncaught
    // exception it dumps eval_code_async's own frames as a traceback (the
    // reported script wrote a CLI-style `if len(sys.argv) < 2: ... exit(1)`
    // guard - this sandbox never has argv, so that branch always fires) that
    // add nothing and read exactly like a crash. pyodide's PythonError
    // exposes the raised class name as `.type`; a clean exit (no code, or 0)
    // is treated as success, matching real shell exit-code semantics.
    const type = (err as { type?: string } | undefined)?.type;
    if (type === "SystemExit") {
      const raw = /SystemExit(?::\s*(.*))?\s*$/.exec(message.trimEnd())?.[1]?.trim();
      if (raw === undefined || raw === "" || raw === "0" || raw === "None") {
        post({ kind: "done", runId });
      } else {
        post({
          kind: "error",
          runId,
          message: `The program called sys.exit(${raw}) - this is an intentional non-zero exit, not a crash. If it wasn't meant to fail, check what condition led to it (e.g. a missing argv/input the sandbox never provides) rather than treating this as a bug in Python itself.`,
        });
      }
      return;
    }
    post({ kind: "error", runId, message });
  }
};
