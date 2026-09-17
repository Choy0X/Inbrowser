import { createWorkerRunner } from "../codeRunners/workerRunner";
import { loadPluginStates, savePluginStates } from "../pluginStore";
import { installCachedRuntimeAssets } from "./cacheStorageRuntimeInstall";
import type { InstallProgress, Plugin } from "./types";

/**
 * C and C++, both served by one Clang/LLVM toolchain (see
 * workers/clangToolchain.ts).
 *
 * TWO Plugin objects, ONE plugin id. That looks like a mistake and is not:
 *
 * - Two objects are required because `CodeRunner.run()` carries no language and
 *   a Plugin exposes a single `createRunner()`, so the dialect can only be
 *   carried by the worker URL. `registry.ts` keys BY_LANGUAGE by language, so
 *   "c" reaches the C object and "cpp"/"c++"/"cxx" the C++ one.
 * - One id is required because everything that tracks state does so per plugin
 *   id: `PluginsView`'s enable toggle writes `config.pluginId`, `codeTools`
 *   filters by `plugin.id`, and the install state lives in one localStorage
 *   key. With two ids, disabling C++ would leave C enabled and still offered to
 *   the model, and uninstalling C would delete a Cache Storage bucket that C++
 *   still believed it had.
 *
 * The store shows one C / C++ row pointing at pluginId "cpp". Underneath
 * there is exactly one ~113MB download, one bucket and
 * one installed/enabled pair. install/uninstall are shared functions rather
 * than living on whichever object PLUGINS.find happens to reach first, so the
 * order of the two entries cannot matter.
 */

export const CLANG_CACHE_NAME = "fachoy-plugin-clang";

/** The single state key both objects read and write. */
const PLUGIN_ID = "cpp";

const BASE_URL = "/cpp/";

/**
 * Compile + link + execute all happen inside one `run` call, so the 20s default
 * would cut off nearly every C++ program. A cold run pays for instantiating
 * clang.wasm on top of that; a warm one is a couple of seconds.
 */
const RUN_TIMEOUT_MS = 90_000;

/** Byte sizes are what Cache Storage actually holds, for the progress labels. */
const FILE_LABELS: Record<string, string> = {
  "clang.wasm": "clang (42.5 MB)",
  "lld.wasm": "wasm-ld (23.2 MB)",
  "sysroot.tar": "C/C++ standard library (28.6 MB)",
  "stdc++.h.pch": "precompiled headers (19.4 MB)",
};

async function installClang(onProgress: (p: InstallProgress) => void, signal: AbortSignal): Promise<void> {
  await installCachedRuntimeAssets({
    cacheName: CLANG_CACHE_NAME,
    baseUrl: BASE_URL,
    manifestUrl: `${BASE_URL}cpp-manifest.json`,
    // Without a label this reads as a hang: seven "files" where two of them are
    // most of a hundred megabytes.
    onProgress: (p) => onProgress({ ...p, text: p.file ? FILE_LABELS[p.file] ?? p.file : undefined }),
    signal,
  });

  // Prove the toolchain actually works while the user is still expecting to
  // wait, rather than discovering it mid-answer. Same reasoning as the warm-up
  // in languagePlugins.ts, but this one really does compile and run a program.
  await new Promise<void>((resolve, reject) => {
    const worker = createCWorker();
    const finish = (err?: Error) => {
      worker.terminate();
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error("The C/C++ toolchain did not start in time.")), RUN_TIMEOUT_MS);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        finish(new Error("Install cancelled."));
      },
      { once: true }
    );
    worker.addEventListener("message", (event: MessageEvent<{ kind: string; message?: string }>) => {
      if (event.data.kind === "done") {
        clearTimeout(timer);
        finish();
      } else if (event.data.kind === "error") {
        clearTimeout(timer);
        finish(new Error(event.data.message ?? "The C/C++ toolchain failed to start."));
      }
    });
    onProgress({ loaded: 0, total: 1, text: "Verifying the compiler..." });
    worker.postMessage({ kind: "run", runId: "warmup", code: "int main(){return 0;}" });
  });

  savePluginStates({ ...loadPluginStates(), [PLUGIN_ID]: { installed: true, enabled: true } });
}

async function uninstallClang(): Promise<void> {
  await caches.delete(CLANG_CACHE_NAME);
  savePluginStates({ ...loadPluginStates(), [PLUGIN_ID]: { installed: false, enabled: false } });
}

const createCWorker = () => new Worker(new URL("../../workers/cWorker.ts", import.meta.url), { type: "module" });
const createCppWorker = () => new Worker(new URL("../../workers/cppWorker.ts", import.meta.url), { type: "module" });

const SHARED = {
  id: PLUGIN_ID,
  // clang.wasm + lld.wasm + sysroot.tar + stdc++.h.pch + the glue, uncompressed
  // (which is what Cache Storage holds); roughly a third of that over the wire,
  // since jsDelivr and any sane host serve them compressed.
  estimatedSizeMB: 113,
  runTimeoutMs: RUN_TIMEOUT_MS,
  install: installClang,
  uninstall: uninstallClang,
} as const;

export const cppPlugin: Plugin = {
  ...SHARED,
  name: "C++",
  description:
    "Real C++20, compiled by Clang and run in your browser. No threads and no exceptions (this toolchain's " +
    "standard library is built without them).",
  languages: ["cpp", "c++", "cxx"],
  createRunner: () =>
    createWorkerRunner({
      languages: ["cpp", "c++", "cxx"],
      createWorker: createCppWorker,
      timeoutMs: RUN_TIMEOUT_MS,
    }),
};

export const cPlugin: Plugin = {
  ...SHARED,
  name: "C",
  description: "Real C17, compiled by Clang and run in your browser. No threads; each run starts from a clean slate.",
  languages: ["c"],
  createRunner: () =>
    createWorkerRunner({ languages: ["c"], createWorker: createCWorker, timeoutMs: RUN_TIMEOUT_MS }),
};
