import { run } from "wasi-sh";
import { lineSplitter } from "./lineSplitter";

/**
 * A real POSIX shell (BusyBox ash + coreutils, compiled to wasm32-wasi via
 * wasi-sh) as a run_code language runtime. Ships v1 on wasi-sh's default
 * in-memory filesystem - persistent OPFS-backed storage hit a reproducible
 * write-back corruption bug in @zenfs/dom during the Agents Builder spike
 * (verified against raw on-disk bytes), so that's deferred; the shell itself
 * works correctly, a script just doesn't see files from a previous run.
 *
 * No interactive stdin: wasi-sh's run() is fork-free and non-interactive by
 * design (same reasoning as every other language here - there is no UI to
 * prompt anyone mid-tool-call), so `interactive`/`buffer` are accepted for
 * protocol-compatibility with workerRunner.ts but never used.
 */

type InMessage = { kind: "run"; runId: string; code: string };
type OutMessage =
  | { kind: "ready"; runId: string }
  | { kind: "stdout" | "stderr"; runId: string; line: string }
  | { kind: "done"; runId: string }
  | { kind: "error"; runId: string; message: string };

function post(msg: OutMessage): void {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = async (event: MessageEvent<InMessage>) => {
  if (event.data.kind !== "run") return;
  const { runId, code } = event.data;

  post({ kind: "ready", runId });

  const stdout = lineSplitter((line) => post({ kind: "stdout", runId, line }));
  const stderr = lineSplitter((line) => post({ kind: "stderr", runId, line }));

  try {
    const result = await run({
      inline: true,
      script: code,
      onOutput: (bytes, channel) => (channel === "stdout" ? stdout.push(bytes) : stderr.push(bytes)),
    });
    stdout.flush();
    stderr.flush();
    if (result.exitCode !== 0) {
      post({ kind: "stderr", runId, line: `(exit code ${result.exitCode})` });
    }
    post({ kind: "done", runId });
  } catch (err) {
    stdout.flush();
    stderr.flush();
    post({ kind: "error", runId, message: err instanceof Error ? err.message : String(err) });
  }
};
