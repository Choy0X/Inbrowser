import { DEFAULT_RUN_TIMEOUT_MS, type CodeRunner, type RunCallbacks, type RunOutcome } from "./types";
import { createInputBuffer, writeInputAnswer } from "./interactiveStdin";

/**
 * One worker-backed runner, shared by every language.
 *
 * `python.ts` and `javascript.ts` were byte-for-byte identical apart from the
 * worker URL and the language list, and each new language would have added
 * another copy. The protocol below is the contract every runtime worker
 * implements.
 *
 * The worker is kept warm between runs (a WASM runtime can take seconds to
 * boot) and force-terminated on stop or timeout, which is the only way to
 * actually halt a runaway program - `terminate()` is a real hard-stop in a way
 * that a sandboxed iframe is not.
 */

export type RunnerRequest = {
  kind: "run";
  runId: string;
  code: string;
  /**
   * Set only when the caller supplied onInputRequest AND SharedArrayBuffer is
   * available - tells the worker to attempt the blocking stdin protocol
   * instead of failing input() immediately. `buffer` passes by reference
   * through postMessage (SharedArrayBuffer needs no transfer list).
   */
  interactive?: boolean;
  buffer?: SharedArrayBuffer;
};

export type RunnerResponse =
  | { kind: "ready"; runId: string }
  | { kind: "stdout"; runId: string; line: string }
  | { kind: "stderr"; runId: string; line: string }
  /** Runtime progress ("Loading numpy, pandas"), not program output. Optional
   *  for a worker to send; only Pyodide does today. */
  | { kind: "status"; runId: string; line: string }
  | { kind: "done"; runId: string }
  | { kind: "error"; runId: string; message: string }
  | { kind: "input-request"; runId: string; prompt: string };

/**
 * Main thread -> worker, sent in reply to an "input-request". A worker that
 * can block its own thread synchronously (Pyodide, and any runtime that
 * evaluates code in-thread) reads the answer via the SharedArrayBuffer/
 * Atomics protocol in interactiveStdin.ts and can ignore this message
 * entirely. A worker whose runtime proxies execution elsewhere (webR spawns
 * its own nested worker and talks to it asynchronously - blocking the outer
 * worker's thread would freeze the very channel needed to hear back from it)
 * listens for this instead and resolves its own pending answer Promise. Both
 * channels are always sent so a single "input-request" handler here works for
 * either kind of worker without the caller needing to know which one it is.
 */
export type RunnerInputAnswer = { kind: "input-answer"; runId: string; value: string | null };

export interface WorkerRunnerOptions {
  /** Language ids this runner answers to, lowercase, aliases included. */
  languages: string[];
  /** Built by the caller so Vite can statically analyse `new URL(...)`. */
  createWorker: () => Worker;
  timeoutMs?: number;
}

export function createWorkerRunner({
  languages,
  createWorker,
  timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
}: WorkerRunnerOptions): CodeRunner {
  let worker: Worker | null = null;
  let counter = 0;

  const ensureWorker = (): Worker => {
    if (!worker) worker = createWorker();
    return worker;
  };

  const terminate = () => {
    worker?.terminate();
    worker = null;
  };

  return {
    matches(language) {
      return Boolean(language) && languages.includes(language!.toLowerCase());
    },

    run(code, callbacks: RunCallbacks): Promise<RunOutcome> {
      const runId = String(++counter);
      const active = ensureWorker();

      // Interactive stdin needs SharedArrayBuffer (cross-origin isolation -
      // see server/src/app.ts). Absent either, the caller's
      // onInputRequest is simply never wired up: the worker gets no buffer,
      // so its own stdin callback falls back to immediate EOF exactly as it
      // does when no onInputRequest was provided at all. Progressive
      // enhancement, never a hard requirement.
      const interactive = Boolean(callbacks.onInputRequest) && typeof SharedArrayBuffer !== "undefined";
      const buffer = interactive ? createInputBuffer() : undefined;

      return new Promise<RunOutcome>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;

        const startTimer = () => {
          timer = setTimeout(() => {
            callbacks.onStderr(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
            terminate();
            finish({ kind: "aborted" });
          }, timeoutMs);
        };

        const finish = (outcome: RunOutcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          active.removeEventListener("message", onMessage);
          callbacks.signal.removeEventListener("abort", onAbort);
          resolve(outcome);
        };

        const onMessage = (event: MessageEvent<RunnerResponse>) => {
          const msg = event.data;
          // A warm worker may still be draining the previous run's output.
          if (msg.runId !== runId) return;
          if (msg.kind === "ready") callbacks.onReady?.();
          else if (msg.kind === "stdout") callbacks.onStdout(msg.line);
          else if (msg.kind === "stderr") callbacks.onStderr(msg.line);
          else if (msg.kind === "status") callbacks.onStatus?.(msg.line);
          else if (msg.kind === "done") finish({ kind: "success" });
          else if (msg.kind === "error") finish({ kind: "error", message: msg.message });
          else if (msg.kind === "input-request") {
            if (!callbacks.onInputRequest) return;
            // A human may take far longer than the run timeout to answer -
            // pause it while a prompt is pending, resume once it's answered.
            clearTimeout(timer);
            void callbacks.onInputRequest(msg.prompt).then((value) => {
              if (settled) return; // aborted/timed out/finished while awaiting the human
              if (buffer) {
                try {
                  writeInputAnswer(buffer, value);
                } catch (err) {
                  // The worker may be physically blocked on this buffer right
                  // now - if writing the real answer throws, it would
                  // otherwise block forever with no diagnostic. Report it,
                  // then fall back to the simplest possible write (EOF) so
                  // the worker still unblocks - if even that throws, there is
                  // truly nothing more this thread can do to reach it.
                  callbacks.onStderr(
                    `[interactive input] failed to send the answer (${err instanceof Error ? err.message : String(err)})`
                  );
                  try {
                    writeInputAnswer(buffer, null);
                  } catch {
                    /* nothing more we can do - the worker will hang until it times out or is stopped */
                  }
                }
              }
              // Sent unconditionally (not only when there's no buffer): a
              // worker whose runtime can't block its own thread synchronously
              // (see RunnerInputAnswer's doc comment) needs this message
              // instead of the buffer; one that does block reads the buffer
              // and simply never listens for this.
              active.postMessage({ kind: "input-answer", runId, value } satisfies RunnerInputAnswer);
              startTimer();
            });
          }
        };

        const onAbort = () => {
          // The worker may be physically blocked in Atomics.wait() on this
          // buffer right now - wake it before terminating so a pending input
          // prompt doesn't leave it parked until termination happens to land.
          if (buffer) writeInputAnswer(buffer, null);
          terminate();
          finish({ kind: "aborted" });
        };

        active.addEventListener("message", onMessage);
        callbacks.signal.addEventListener("abort", onAbort, { once: true });
        startTimer();
        active.postMessage({ kind: "run", runId, code, interactive, buffer } satisfies RunnerRequest);
      });
    },

    dispose: terminate,
  };
}
