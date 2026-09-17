/**
 * Plugin manifests.
 *
 * The store used to be a hardcoded array of two objects, each carrying live
 * install/createRunner *functions*. That cannot scale to a real catalog or
 * accept third-party entries, so plugins are split in two:
 *
 *   - PluginManifest: pure data. Serializable, so a catalog can be a JSON file
 *     (bundled or remote) and a new plugin is usually a data entry.
 *   - PluginExecutor: a handful of generic implementations, selected by `kind`.
 *
 * Adding a WebLLM model is then a manifest entry with no new code at all, which
 * is how the catalog reaches hundreds of items without hundreds of closures.
 */

export type PluginCategory = "runtime" | "model" | "tool" | "package";

export type PluginKind =
  /** A language runtime with its own bespoke installer (Pyodide, the JS worker). */
  | "builtin-runtime"
  /** Weights for a local model, downloaded through the inference runtime. */
  | "local-model"
  /** Sandboxed JavaScript that contributes tools to the agent loop. */
  | "worker-tool"
  /** A Python library from the Pyodide distribution, downloaded as a wheel into
   *  the Python runtime's own Cache Storage bucket. */
  | "python-package";

export type PluginRequirement = "webgpu" | "wasm" | "chrome-ai";

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  category: PluginCategory;
  kind: PluginKind;
  tags: string[];
  author?: string;
  homepage?: string;
  license?: string;
  /** Download size, used to warn before a large install. 0 = nothing to fetch. */
  estimatedSizeMB: number;
  /** Ships as part of the app itself: cannot be toggled off or removed. */
  builtin?: boolean;
  requires?: PluginRequirement[];
  /** Kind-specific settings, read only by that kind's executor. */
  config: Record<string, unknown>;
}

export interface InstallProgress {
  loaded: number;
  total: number;
  /** Human-readable stage, when the executor can report one. */
  text?: string;
}

export interface PluginExecutor {
  kind: PluginKind;
  install(manifest: PluginManifest, onProgress: (p: InstallProgress) => void, signal: AbortSignal): Promise<void>;
  uninstall(manifest: PluginManifest): Promise<void>;
  isInstalled(manifest: PluginManifest): Promise<boolean>;
}

/** Whether this device can run a plugin at all. */
export function unmetRequirement(manifest: PluginManifest): PluginRequirement | null {
  for (const requirement of manifest.requires ?? []) {
    if (requirement === "webgpu" && !(typeof navigator !== "undefined" && "gpu" in navigator)) return "webgpu";
    if (requirement === "wasm" && typeof WebAssembly === "undefined") return "wasm";
    if (requirement === "chrome-ai" && !("LanguageModel" in globalThis)) return "chrome-ai";
  }
  return null;
}

export function requirementLabel(requirement: PluginRequirement): string {
  switch (requirement) {
    case "webgpu":
      return "Needs WebGPU (Chrome or Edge 113+ with a supported GPU)";
    case "chrome-ai":
      return "Needs Chrome 138+ with the built-in AI model";
    default:
      return "Needs WebAssembly support";
  }
}
