import { createWorkerRunner } from "../codeRunners/workerRunner";
import { loadPluginStates, savePluginStates } from "../pluginStore";
import { installCachedRuntimeAssets } from "./cacheStorageRuntimeInstall";
import type { InstallProgress, Plugin } from "./types";

export const RUBY_CACHE_NAME = "fachoy-plugin-ruby";

export const rubyPlugin: Plugin = {
  id: "ruby",
  name: "Ruby",
  description: "Real Ruby, compiled to WebAssembly (ruby.wasm), running fully in your browser.",
  estimatedSizeMB: 31,
  languages: ["ruby", "rb"],

  async install(onProgress: (p: InstallProgress) => void, signal: AbortSignal): Promise<void> {
    await installCachedRuntimeAssets({
      cacheName: RUBY_CACHE_NAME,
      baseUrl: "/ruby/",
      manifestUrl: "/ruby/ruby-manifest.json",
      onProgress,
      signal,
    });

    const states = loadPluginStates();
    savePluginStates({ ...states, ruby: { installed: true, enabled: true } });
  },

  async uninstall(): Promise<void> {
    await caches.delete(RUBY_CACHE_NAME);
    const states = loadPluginStates();
    savePluginStates({ ...states, ruby: { installed: false, enabled: false } });
  },

  createRunner: () =>
    createWorkerRunner({
      languages: ["ruby", "rb"],
      createWorker: () => new Worker(new URL("../../workers/rubyWorker.ts", import.meta.url), { type: "module" }),
    }),
};
