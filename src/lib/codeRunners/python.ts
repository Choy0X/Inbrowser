import type { CodeRunner } from "./types";
import { createWorkerRunner } from "./workerRunner";

/**
 * Python, via Pyodide in a dedicated worker. The lifecycle - warm between runs,
 * hard-terminated on stop or timeout - lives in createWorkerRunner, which every
 * language shares.
 */
export function createPythonRunner(): CodeRunner {
  return createWorkerRunner({
    languages: ["python", "py", "python3"],
    createWorker: () =>
      new Worker(new URL("../../workers/pyodideWorker.ts", import.meta.url), { type: "module" }),
  });
}
