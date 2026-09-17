/**
 * The SharedArrayBuffer protocol between workerRunner.ts (main thread) and a
 * language worker (pyodideWorker.ts, jsRunnerWorker.ts, typescriptWorker.ts,
 * luaWorker.ts, clojureWorker.ts - any worker that evaluates code
 * synchronously in its own thread) for pausing a running program on input()
 * and waking it once a human answers. Each of these runtimes' read hook is
 * called synchronously mid-execution - there is no way to `await` inside it,
 * so the only way a human's keystroke can reach it is to physically block the
 * worker thread with Atomics.wait() until the main thread writes an answer
 * here and wakes it with Atomics.notify(). A worker that can't block its own
 * thread this way (rWorker.ts - webR proxies execution to its own nested
 * worker asynchronously) uses the RunnerInputAnswer message instead; see its
 * doc comment in workerRunner.ts. Kept in one module, imported by every
 * synchronous-pattern worker, so the layout can't drift between them.
 *
 * Requires SharedArrayBuffer (cross-origin isolation - see vite.config.ts's
 * and the Cross-Origin-Opener/Embedder-Policy headers the server in `server/` sets on every response). Every caller
 * must feature-detect (`typeof SharedArrayBuffer !== "undefined"`) before
 * using this - it does not exist at all on a host that hasn't set those
 * headers, and that must fall back to the existing immediate-EOF stdin
 * behavior, not throw.
 */

export const INPUT_STATE_IDLE = 0;
/** Worker has posted an input-request and is about to block (or already is). */
export const INPUT_STATE_REQUESTED = 1;
/** Main thread wrote a real answer; length (bytes) is in control[1]. */
export const INPUT_STATE_ANSWERED = 2;
/** Main thread gave up (human canceled) - the worker should treat this as EOF. */
export const INPUT_STATE_EOF = 3;

/** Generous for realistic input() answers; longer input is truncated. */
export const INPUT_ANSWER_MAX_BYTES = 4096;
/** control[0] = state, control[1] = answer byte length. */
const CONTROL_INT32_LEN = 2;
const CONTROL_BYTES = CONTROL_INT32_LEN * 4;
export const INPUT_BUFFER_BYTES = CONTROL_BYTES + INPUT_ANSWER_MAX_BYTES;

export function createInputBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(INPUT_BUFFER_BYTES);
}

function control(buffer: SharedArrayBuffer): Int32Array {
  return new Int32Array(buffer, 0, CONTROL_INT32_LEN);
}

function answerBytes(buffer: SharedArrayBuffer): Uint8Array {
  return new Uint8Array(buffer, CONTROL_BYTES, INPUT_ANSWER_MAX_BYTES);
}

/** Main thread: called once a human answers (or cancels with `value: null`). */
export function writeInputAnswer(buffer: SharedArrayBuffer, value: string | null): void {
  const ctrl = control(buffer);
  if (value === null) {
    Atomics.store(ctrl, 1, 0);
    Atomics.store(ctrl, 0, INPUT_STATE_EOF);
    Atomics.notify(ctrl, 0);
    return;
  }
  const bytes = new TextEncoder().encode(value);
  const len = Math.min(bytes.length, INPUT_ANSWER_MAX_BYTES);
  answerBytes(buffer).set(bytes.subarray(0, len));
  Atomics.store(ctrl, 1, len);
  Atomics.store(ctrl, 0, INPUT_STATE_ANSWERED);
  Atomics.notify(ctrl, 0);
}

/**
 * Worker thread only: marks the buffer as "requesting" and blocks this
 * thread until the main thread answers or gives up. Synchronous by design -
 * this is called from inside Pyodide's synchronous `stdin` callback.
 */
export function requestInputSync(buffer: SharedArrayBuffer): string | null {
  const ctrl = control(buffer);
  Atomics.store(ctrl, 0, INPUT_STATE_REQUESTED);
  Atomics.wait(ctrl, 0, INPUT_STATE_REQUESTED);
  const state = Atomics.load(ctrl, 0);
  if (state === INPUT_STATE_EOF) return null;
  const len = Atomics.load(ctrl, 1);
  // TextDecoder.decode() refuses a view backed directly by a SharedArrayBuffer
  // in browsers ("The provided ArrayBufferView value must not be shared") -
  // Node's implementation doesn't enforce this, which is exactly why this bug
  // passed Node-based verification but failed in a real browser. `new
  // Uint8Array(view)` copies into a fresh, non-shared ArrayBuffer first.
  return new TextDecoder().decode(new Uint8Array(answerBytes(buffer).subarray(0, len)));
}
