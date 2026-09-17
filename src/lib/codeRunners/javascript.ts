import type { CodeRunner } from "./types";
import { createWorkerRunner } from "./workerRunner";

/**
 * JavaScript, executed in a real Worker rather than the sandboxed preview
 * iframe: an iframe is a privilege boundary, not a thread boundary, so only a
 * worker can actually be terminated mid-run.
 */
export function createJavaScriptRunner(): CodeRunner {
  return createWorkerRunner({
    languages: ["javascript", "js", "node", "nodejs", "mjs"],
    createWorker: () =>
      new Worker(new URL("../../workers/jsRunnerWorker.ts", import.meta.url), { type: "module" }),
  });
}
