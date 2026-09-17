import { createWorkerRunner } from "../codeRunners/workerRunner";
import { loadPluginStates, savePluginStates } from "../pluginStore";
import { installCachedRuntimeAssets } from "./cacheStorageRuntimeInstall";
import type { InstallProgress, Plugin } from "./types";

export const PHP_CACHE_NAME = "fachoy-plugin-php";

export const phpPlugin: Plugin = {
  id: "php",
  name: "PHP",
  description: "PHP 8.5, compiled to WebAssembly (WordPress Playground's php-wasm), running fully in your browser.",
  estimatedSizeMB: 42,
  languages: ["php"],

  async install(onProgress: (p: InstallProgress) => void, signal: AbortSignal): Promise<void> {
    await installCachedRuntimeAssets({
      cacheName: PHP_CACHE_NAME,
      baseUrl: "/php/",
      manifestUrl: "/php/php-manifest.json",
      onProgress,
      signal,
    });

    const states = loadPluginStates();
    savePluginStates({ ...states, php: { installed: true, enabled: true } });
  },

  async uninstall(): Promise<void> {
    await caches.delete(PHP_CACHE_NAME);
    const states = loadPluginStates();
    savePluginStates({ ...states, php: { installed: false, enabled: false } });
  },

  createRunner: () =>
    createWorkerRunner({
      languages: ["php"],
      createWorker: () => new Worker(new URL("../../workers/phpWorker.ts", import.meta.url), { type: "module" }),
    }),
};
