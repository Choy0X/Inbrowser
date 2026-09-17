import { createWorkerRunner } from "../codeRunners/workerRunner";
import { loadPluginStates, savePluginStates } from "../pluginStore";
import { installCachedRuntimeAssets } from "./cacheStorageRuntimeInstall";
import type { InstallProgress, Plugin } from "./types";

export const R_CACHE_NAME = "fachoy-plugin-r";

export const rPlugin: Plugin = {
  id: "r",
  name: "R",
  description: "Real R, compiled to WebAssembly (webR), running fully in your browser.",
  estimatedSizeMB: 21,
  languages: ["r"],

  async install(onProgress: (p: InstallProgress) => void, signal: AbortSignal): Promise<void> {
    // Only the boot-critical core is tracked here - see vite.config.ts's "r"
    // RUNTIME_ASSET_CONFIGS entry for why the ~130 small per-package data
    // files webR also ships aren't part of this progress-tracked set.
    await installCachedRuntimeAssets({
      cacheName: R_CACHE_NAME,
      baseUrl: "/r/",
      manifestUrl: "/r/r-manifest.json",
      onProgress,
      signal,
    });

    const states = loadPluginStates();
    savePluginStates({ ...states, r: { installed: true, enabled: true } });
  },

  async uninstall(): Promise<void> {
    await caches.delete(R_CACHE_NAME);
    const states = loadPluginStates();
    savePluginStates({ ...states, r: { installed: false, enabled: false } });
  },

  createRunner: () =>
    createWorkerRunner({
      languages: ["r"],
      createWorker: () => new Worker(new URL("../../workers/rWorker.ts", import.meta.url), { type: "module" }),
    }),
};
