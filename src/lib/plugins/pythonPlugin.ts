import { createPythonRunner } from "../codeRunners/python";
import { loadPluginStates, savePluginStates } from "../pluginStore";
import { clearInstalledPackages } from "../python/packageStore";
import { installCachedRuntimeAssets } from "./cacheStorageRuntimeInstall";
import type { InstallProgress, Plugin } from "./types";

export const PYTHON_CACHE_NAME = "fachoy-plugin-python";

export const pythonPlugin: Plugin = {
  id: "python",
  name: "Python",
  description: "Real CPython, compiled to WebAssembly (Pyodide), running fully in your browser.",
  estimatedSizeMB: 13,
  languages: ["python", "py", "python3"],

  async install(onProgress: (p: InstallProgress) => void, signal: AbortSignal): Promise<void> {
    await installCachedRuntimeAssets({
      cacheName: PYTHON_CACHE_NAME,
      baseUrl: "/pyodide/",
      manifestUrl: "/pyodide/pyodide-manifest.json",
      onProgress,
      signal,
    });

    const states = loadPluginStates();
    savePluginStates({ ...states, python: { installed: true, enabled: true } });
  },

  async uninstall(): Promise<void> {
    await caches.delete(PYTHON_CACHE_NAME);
    // Package wheels live in that same bucket, so removing the runtime removes
    // them too - the record has to go with them or every package would still
    // read as installed after a reinstall that downloaded none of them.
    clearInstalledPackages();
    const states = loadPluginStates();
    savePluginStates({ ...states, python: { installed: false, enabled: false } });
  },

  createRunner: createPythonRunner,
};
