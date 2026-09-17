import type { Plugin } from "./types";
import { createWorkerRunner } from "../codeRunners/workerRunner";
import { loadPluginStates, savePluginStates } from "../pluginStore";

/**
 * Language runtimes whose engine ships with the app.
 *
 * Their WASM is imported with `?url` inside the worker, so Vite fingerprints it
 * and serves it from our own origin - no CDN, and the service worker caches it
 * on first use like any other asset. That means "install" here is a preference
 * rather than a download: it decides whether the runtime is offered to the
 * model and shown as runnable, and warms the engine so the first real run is
 * not the one that pays for the fetch.
 */

interface LanguageSpec {
  id: string;
  name: string;
  description: string;
  languages: string[];
  estimatedSizeMB: number;
  createWorker: () => Worker;
}

const SPECS: LanguageSpec[] = [
  {
    id: "sqlite",
    name: "SQLite",
    description:
      "Run real SQL against an in-memory database. Each run starts from a clean database, so snippets are reproducible.",
    languages: ["sql", "sqlite", "sqlite3"],
    estimatedSizeMB: 1,
    createWorker: () => new Worker(new URL("../../workers/sqliteWorker.ts", import.meta.url), { type: "module" }),
  },
  {
    id: "lua",
    name: "Lua",
    description: "Lua 5.4 in the browser. Fast to start and small, with print() wired to the output pane.",
    languages: ["lua"],
    estimatedSizeMB: 1,
    createWorker: () => new Worker(new URL("../../workers/luaWorker.ts", import.meta.url), { type: "module" }),
  },
  {
    id: "typescript",
    name: "TypeScript",
    description:
      "Transpile and run TypeScript. Types are erased rather than checked, so this runs a snippet but will not catch type errors.",
    languages: ["typescript", "ts", "tsx"],
    estimatedSizeMB: 14,
    createWorker: () =>
      new Worker(new URL("../../workers/typescriptWorker.ts", import.meta.url), { type: "module" }),
  },
  {
    id: "clojure",
    name: "Clojure",
    description: "Clojure via Scittle, a lightweight SCI-based interpreter. Fast to start, no build step.",
    languages: ["clojure", "clj", "cljs"],
    estimatedSizeMB: 1,
    createWorker: () =>
      new Worker(new URL("../../workers/clojureWorker.ts", import.meta.url), { type: "module" }),
  },
  {
    // wasi-sh's JS is ISC-licensed; the busybox.wasm binary it ships is
    // GPL-2.0 (upstream BusyBox). Fetched as a separate runtime asset at
    // install time, same as every other language engine here (Pyodide,
    // Ruby, R, PHP each ship their own separately-licensed runtime) - not
    // statically linked into this app's own source.
    id: "wasi-shell",
    name: "Shell",
    description:
      "A real POSIX shell (BusyBox ash + coreutils - pipes, redirects, grep/sed/awk/find) via wasi-sh, compiled " +
      "to WebAssembly. Fork-free: no background processes, no job control, and each run starts from an empty " +
      "in-memory filesystem (nothing persists between runs).",
    languages: ["sh", "shell", "bash", "ash", "busybox"],
    estimatedSizeMB: 1,
    createWorker: () => new Worker(new URL("../../workers/wasiShellWorker.ts", import.meta.url), { type: "module" }),
  },
];

function toPlugin(spec: LanguageSpec): Plugin {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    languages: spec.languages,
    estimatedSizeMB: spec.estimatedSizeMB,
    async install(onProgress, signal) {
      onProgress({ loaded: 0, total: 1 });
      // Warm the engine so the first real run doesn't pay the compile cost, and
      // so a broken runtime fails here rather than mid-answer.
      await new Promise<void>((resolve, reject) => {
        const worker = spec.createWorker();
        const done = (err?: Error) => {
          worker.terminate();
          err ? reject(err) : resolve();
        };
        const timer = setTimeout(() => done(new Error("The runtime did not start in time.")), 30_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          done(new Error("Install cancelled."));
        }, { once: true });
        worker.addEventListener("message", (event: MessageEvent<{ kind: string; message?: string }>) => {
          if (event.data.kind === "ready" || event.data.kind === "done") {
            clearTimeout(timer);
            done();
          } else if (event.data.kind === "error") {
            clearTimeout(timer);
            done(new Error(event.data.message ?? "The runtime failed to start."));
          }
        });
        worker.postMessage({ kind: "run", runId: "warmup", code: WARMUP[spec.id] ?? "" });
      });
      onProgress({ loaded: 1, total: 1 });
      savePluginStates({ ...loadPluginStates(), [spec.id]: { installed: true, enabled: true } });
    },
    async uninstall() {
      savePluginStates({ ...loadPluginStates(), [spec.id]: { installed: false, enabled: false } });
    },
    createRunner: () => createWorkerRunner({ languages: spec.languages, createWorker: spec.createWorker }),
  };
}

/** Trivial programs used only to prove the engine boots. */
const WARMUP: Record<string, string> = {
  sqlite: "SELECT 1;",
  lua: "return 1",
  typescript: "const _x: number = 1;",
  clojure: "(+ 1 1)",
  "wasi-shell": "echo 1",
};

export const LANGUAGE_PLUGINS: Plugin[] = SPECS.map(toPlugin);
