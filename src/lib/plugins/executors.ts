import type { InstallProgress, PluginExecutor, PluginManifest } from "./manifest";
import { PLUGINS } from "./registry";
import { loadPluginStates, getPluginState, savePluginStates } from "../pluginStore";
import { registerLocalModel, unregisterLocalModel } from "../gateway/local/register";

/** The runtime every "local-model" plugin belongs to. */
const RUNTIME_ID = "webllm";

/**
 * The generic executors behind the catalog. Six kinds were planned; three exist
 * because those are the ones with a real implementation behind them - listing
 * kinds that cannot actually install anything would make the store lie.
 */

/**
 * Language runtimes whose install is genuinely bespoke - Pyodide fetches a
 * build manifest and caches four specific files; the JS runner has nothing to
 * download at all. They keep their own code and this adapts them to the
 * manifest interface.
 */
const builtinRuntime: PluginExecutor = {
  kind: "builtin-runtime",

  async install(manifest, onProgress, signal) {
    const plugin = PLUGINS.find((p) => p.id === manifest.config.pluginId);
    if (!plugin) throw new Error(`No runtime registered for "${manifest.id}".`);
    // `text` is forwarded, not dropped: a runtime whose install is a handful
    // of very large files needs to say which one it is on.
    await plugin.install((p) => onProgress({ loaded: p.loaded, total: p.total, text: p.text }), signal);
  },

  async uninstall(manifest) {
    const plugin = PLUGINS.find((p) => p.id === manifest.config.pluginId);
    await plugin?.uninstall();
  },

  async isInstalled(manifest) {
    const plugin = PLUGINS.find((p) => p.id === manifest.config.pluginId);
    if (!plugin) return false;
    if (plugin.builtin) return true;
    return getPluginState(loadPluginStates(), plugin.id).installed;
  },
};

/**
 * Local model weights.
 *
 * WebLLM manages its own Cache Storage buckets internally, so installing here
 * means asking it to fetch and compile the model once; afterwards it loads from
 * cache and runs offline. Progress comes from the same callback the chat path
 * uses.
 */
const localModel: PluginExecutor = {
  kind: "local-model",

  async install(manifest, onProgress, signal) {
    const modelId = String(manifest.config.modelId ?? "");
    if (!modelId) throw new Error("This model entry has no modelId.");

    const webllm = await import("@mlc-ai/web-llm");
    const worker = new Worker(new URL("../../workers/webllmWorker.ts", import.meta.url), {
      type: "module",
    });

    try {
      const engine = await webllm.CreateWebWorkerMLCEngine(worker, modelId, {
        initProgressCallback: (report) => {
          onProgress({
            loaded: Math.round((report.progress ?? 0) * 100),
            total: 100,
            text: report.text,
          });
        },
      });
      if (signal.aborted) throw new Error("Install cancelled.");
      // Loading it once is the install: the weights are now in Cache Storage.
      await engine.unload();
    } finally {
      worker.terminate();
    }

    const installed = await installedModelIds();
    installed.add(modelId);
    await saveInstalledModels(installed);
    // Downloading the weights is only half of an install: the chat model list
    // is built from provider connections, so without this the model sits on
    // disk, reads as installed, and never appears in the picker.
    // The context window travels with the registration: promptScale.ts uses it
    // to decide how much instruction a model can be given, and without it the
    // only signal is whatever the id happens to declare.
    const record = webllm.prebuiltAppConfig.model_list.find((m) => m.model_id === modelId);
    registerLocalModel(RUNTIME_ID, modelId, manifest.name, record?.overrides?.context_window_size ?? undefined);
  },

  async uninstall(manifest) {
    const modelId = String(manifest.config.modelId ?? "");
    try {
      const webllm = await import("@mlc-ai/web-llm");
      await webllm.deleteModelAllInfoInCache(modelId);
    } catch {
      /* the weights may already be gone; forget it either way */
    }
    const installed = await installedModelIds();
    installed.delete(modelId);
    await saveInstalledModels(installed);
    unregisterLocalModel(RUNTIME_ID, modelId);
  },

  /**
   * Cheap first, accurate second.
   *
   * `hasModelInCache` needs the ~6 MB WebLLM module loaded and then probes
   * Cache Storage, so asking it about every catalogue entry is ruinous - the
   * catalogue has 160+ models. Our own install record is a single localStorage
   * read and answers correctly for anything installed through the store, so it
   * settles the common case; only an id we have no record of falls through to
   * the real probe, and callers are expected to ask lazily (per visible row)
   * rather than for the whole catalogue at once.
   */
  async isInstalled(manifest) {
    const modelId = String(manifest.config.modelId ?? "");
    if (!modelId) return false;
    if (installedModelIdsSync().has(modelId)) return true;
    try {
      const webllm = await import("@mlc-ai/web-llm");
      return await webllm.hasModelInCache(modelId);
    } catch {
      return false;
    }
  },
};

const MODELS_KEY = "fachoy:installed-models:v1";

/**
 * Models this app installed, as recorded at install time. Synchronous by design:
 * it is the fast path that keeps the store from probing Cache Storage 160+ times.
 */
export function installedModelIdsSync(): Set<string> {
  try {
    const raw = localStorage.getItem(MODELS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

async function installedModelIds(): Promise<Set<string>> {
  return installedModelIdsSync();
}

async function saveInstalledModels(ids: Set<string>): Promise<void> {
  try {
    localStorage.setItem(MODELS_KEY, JSON.stringify([...ids]));
  } catch {
    /* ignore */
  }
}

/**
 * Sandboxed JavaScript tools. The code runs in a Worker with no DOM and no
 * ambient network, for the same reason generated code does (see
 * workers/jsRunnerWorker.ts): a plugin is untrusted third-party code.
 */
const workerTool: PluginExecutor = {
  kind: "worker-tool",

  async install(manifest, onProgress) {
    // First-party tools ship in the app as one lazily-imported chunk, so there
    // is nothing to fetch: installing means "offer this to the model", and the
    // loader picks it up immediately.
    onProgress({ loaded: 1, total: 1, text: "Enabling" });
    savePluginStates({ ...loadPluginStates(), [manifest.id]: { installed: true, enabled: true } });
    const { syncToolPlugins } = await import("../tools/toolPlugins");
    await syncToolPlugins();
  },

  async uninstall(manifest) {
    savePluginStates({ ...loadPluginStates(), [manifest.id]: { installed: false, enabled: false } });
    const { syncToolPlugins } = await import("../tools/toolPlugins");
    await syncToolPlugins();
  },

  async isInstalled(manifest) {
    return getPluginState(loadPluginStates(), manifest.id).installed;
  },
};

/**
 * Install state for a whole catalogue without touching Cache Storage.
 *
 * Answers instantly for every entry, and is right for anything installed
 * through this app. The store seeds its rows from this and refines a row with
 * the real probe only when that row is actually rendered.
 */
export function knownInstalledIds(manifests: PluginManifest[]): Set<string> {
  const models = installedModelIdsSync();
  const states = loadPluginStates();
  const known = new Set<string>();
  for (const manifest of manifests) {
    if (manifest.kind === "local-model") {
      if (models.has(String(manifest.config.modelId ?? ""))) known.add(manifest.id);
    } else if (manifest.kind === "worker-tool") {
      if (getPluginState(states, manifest.id).installed) known.add(manifest.id);
    } else if (manifest.kind === "builtin-runtime") {
      const pluginId = String(manifest.config.pluginId ?? "");
      const plugin = PLUGINS.find((p) => p.id === pluginId);
      if (plugin?.builtin || getPluginState(states, pluginId).installed) known.add(manifest.id);
    }
  }
  return known;
}

const EXECUTORS: PluginExecutor[] = [builtinRuntime, localModel, workerTool];

export function executorFor(manifest: PluginManifest): PluginExecutor {
  const executor = EXECUTORS.find((e) => e.kind === manifest.kind);
  if (!executor) throw new Error(`No executor for plugin kind "${manifest.kind}".`);
  return executor;
}

export async function installPlugin(
  manifest: PluginManifest,
  onProgress: (p: InstallProgress) => void,
  signal: AbortSignal
): Promise<void> {
  await executorFor(manifest).install(manifest, onProgress, signal);
}

export async function uninstallPlugin(manifest: PluginManifest): Promise<void> {
  await executorFor(manifest).uninstall(manifest);
}

export async function isPluginInstalled(manifest: PluginManifest): Promise<boolean> {
  try {
    return await executorFor(manifest).isInstalled(manifest);
  } catch {
    return false;
  }
}
