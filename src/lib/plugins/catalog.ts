import type { PluginManifest } from "./manifest";

/**
 * The bundled catalog.
 *
 * Ships inside the app so the store works offline and needs no server. Runtime
 * and tool entries wrap implementations that actually exist; model entries are
 * pure data over WebLLM's prebuilt list, which is where the size comes from.
 *
 * Nothing is listed here that cannot actually install. A store that offers
 * things which fail on click is worse than a small store.
 */

const RUNTIMES: PluginManifest[] = [
  {
    id: "javascript",
    name: "JavaScript",
    description:
      "Run generated JavaScript in a dedicated Worker. Built in, so there is nothing to download.",
    version: "1.0.0",
    category: "runtime",
    kind: "builtin-runtime",
    tags: ["javascript", "js", "typescript", "code"],
    estimatedSizeMB: 0,
    builtin: true,
    config: { pluginId: "javascript" },
  },
  {
    id: "python",
    name: "Python (Pyodide)",
    description:
      "CPython compiled to WebAssembly, with the full standard library. Runs generated Python entirely in your browser.",
    version: "1.0.0",
    category: "runtime",
    kind: "builtin-runtime",
    tags: ["python", "py", "data", "code"],
    license: "MPL-2.0",
    homepage: "https://pyodide.org",
    estimatedSizeMB: 13,
    requires: ["wasm"],
    config: { pluginId: "python" },
  },
  {
    id: "sqlite",
    name: "SQLite",
    description:
      "Run real SQL against an in-memory database. Every run starts clean, so a snippet always produces the same result.",
    version: "1.14.2",
    category: "runtime",
    kind: "builtin-runtime",
    tags: ["sql", "sqlite", "database", "data"],
    license: "MIT",
    homepage: "https://sql.js.org",
    estimatedSizeMB: 1,
    requires: ["wasm"],
    config: { pluginId: "sqlite" },
  },
  {
    id: "lua",
    name: "Lua",
    description: "Lua 5.4 in the browser. Small, fast to start, with print() wired to the output pane.",
    version: "1.16.0",
    category: "runtime",
    kind: "builtin-runtime",
    tags: ["lua", "scripting", "code"],
    license: "MIT",
    homepage: "https://github.com/ceifa/wasmoon",
    estimatedSizeMB: 1,
    requires: ["wasm"],
    config: { pluginId: "lua" },
  },
  {
    id: "typescript",
    name: "TypeScript",
    description:
      "Transpile and run TypeScript. Types are erased rather than checked, so this executes a snippet but will not catch type errors.",
    version: "0.28.2",
    category: "runtime",
    kind: "builtin-runtime",
    tags: ["typescript", "ts", "javascript", "code"],
    license: "MIT",
    homepage: "https://esbuild.github.io",
    estimatedSizeMB: 14,
    requires: ["wasm"],
    config: { pluginId: "typescript" },
  },
  {
    id: "clojure",
    name: "Clojure",
    description:
      "Run Clojure code directly in your browser using Scittle, a lightweight SCI-based ClojureScript interpreter with no build step.",
    version: "0.8.33",
    category: "runtime",
    kind: "builtin-runtime",
    tags: ["clojure", "clojurescript", "lisp", "functional", "code"],
    license: "EPL-1.0",
    homepage: "https://github.com/babashka/scittle",
    estimatedSizeMB: 1,
    config: { pluginId: "clojure" },
  },
  {
    id: "wasi-shell",
    name: "Shell",
    description:
      "A real POSIX shell (BusyBox ash + coreutils - pipes, redirects, grep/sed/awk/find) compiled to WebAssembly via wasi-sh. Fork-free: no background processes, no job control, and each run starts from an empty filesystem.",
    version: "0.11.0",
    category: "runtime",
    kind: "builtin-runtime",
    tags: ["shell", "bash", "sh", "busybox", "code"],
    // wasi-sh's own JS wrapper is ISC; the busybox.wasm binary it ships (upstream BusyBox) is GPL-2.0.
    license: "ISC + GPL-2.0 (busybox.wasm)",
    homepage: "https://github.com/alganet/wasi-sh",
    estimatedSizeMB: 1,
    requires: ["wasm"],
    config: { pluginId: "wasi-shell" },
  },
  {
    id: "php",
    name: "PHP",
    description:
      "Run PHP code directly in your browser using the php-wasm runtime from WordPress Playground. Downloads both engine variants your browser might need, so it's a larger install.",
    version: "3.1.54",
    category: "runtime",
    kind: "builtin-runtime",
    tags: ["php", "web", "server-side", "code"],
    license: "MIT",
    homepage: "https://github.com/WordPress/wordpress-playground",
    estimatedSizeMB: 42,
    requires: ["wasm"],
    config: { pluginId: "php" },
  },
  {
    id: "ruby",
    name: "Ruby",
    description: "Run Ruby code directly in your browser using ruby.wasm, an official CRuby build compiled to WebAssembly.",
    version: "2.10.1",
    category: "runtime",
    kind: "builtin-runtime",
    tags: ["ruby", "scripting", "dynamic", "code"],
    license: "BSD-2-Clause",
    homepage: "https://github.com/ruby/ruby.wasm",
    estimatedSizeMB: 31,
    requires: ["wasm"],
    config: { pluginId: "ruby" },
  },
  {
    id: "r",
    name: "R",
    description:
      "Run R code directly in your browser using webR, a WebAssembly build of the R interpreter for statistical computing.",
    version: "0.6.0",
    category: "runtime",
    kind: "builtin-runtime",
    tags: ["r", "statistics", "data-science", "code"],
    license: "MIT",
    homepage: "https://docs.r-wasm.org/webr/",
    estimatedSizeMB: 21,
    requires: ["wasm"],
    config: { pluginId: "r" },
  },
  {
    // One store entry for both dialects. Keep "cpp" for existing install state.
    id: "cpp",
    name: "C / C++",
    description:
      "Run C17 and C++20 in your browser with one shared Clang/LLVM toolchain and WebAssembly runtime. " +
      "Large one-time download; no threads or C++ exceptions. " +
      "Bundles mini-gmp, so #include <gmp.h> works for bignum arithmetic.",
    version: "0.1.1",
    category: "runtime",
    kind: "builtin-runtime",
    tags: ["c", "c17", "cpp", "c++", "c++20", "cxx", "clang", "llvm", "gmp", "systems", "code"],
    // The MIT licence on browsercc covers its ~5kB of wrapper. What actually
    // ships here is LLVM/clang, wasi-libc and libc++ - same reasoning as the
    // busybox note on wasi-shell in languagePlugins.ts.
    license: "Apache-2.0 WITH LLVM-exception",
    homepage: "https://github.com/BertalanD/browsercc",
    estimatedSizeMB: 113,
    requires: ["wasm"],
    config: { pluginId: "cpp" },
  },
];

/**
 * Models worth surfacing by default, chosen to span the useful size range
 * rather than to be exhaustive - the full WebLLM catalog (160+) is merged in at
 * runtime by `buildCatalog`.
 */
const FEATURED_MODELS: { modelId: string; name: string; sizeMB: number; tags: string[]; description: string }[] = [
  {
    modelId: "Llama-3.2-1B-Instruct-q4f32_1-MLC",
    name: "Llama 3.2 1B",
    sizeMB: 1100,
    tags: ["small", "fast", "meta"],
    description: "The lightest useful general model. Good first choice on a laptop.",
  },
  {
    modelId: "Llama-3.2-3B-Instruct-q4f32_1-MLC",
    name: "Llama 3.2 3B",
    sizeMB: 2300,
    tags: ["balanced", "meta"],
    description: "Noticeably stronger than 1B while still comfortable on most machines.",
  },
  {
    modelId: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    name: "Qwen 2.5 3B",
    sizeMB: 2000,
    tags: ["balanced", "multilingual", "qwen"],
    description: "Strong multilingual instruction following at a modest size.",
  },
  {
    modelId: "Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC",
    name: "Qwen 2.5 Coder 7B",
    sizeMB: 4200,
    tags: ["code", "qwen"],
    description: "Code-specialised. Pairs well with the Python and JavaScript runtimes.",
  },
  {
    modelId: "DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC",
    name: "DeepSeek R1 Distill 7B",
    sizeMB: 4400,
    tags: ["reasoning", "deepseek"],
    description: "A reasoning-tuned distillation. Slower, but works through harder problems.",
  },
  {
    modelId: "gemma-2-2b-it-q4f16_1-MLC",
    name: "Gemma 2 2B",
    sizeMB: 1600,
    tags: ["small", "google"],
    description: "Small, efficient and a good all-rounder for everyday questions.",
  },
  {
    modelId: "Phi-3.5-mini-instruct-q4f16_1-MLC",
    name: "Phi 3.5 Mini",
    sizeMB: 2200,
    tags: ["small", "microsoft", "reasoning"],
    description: "Punches above its size on reasoning and structured output.",
  },
  {
    modelId: "Mistral-7B-Instruct-v0.3-q4f16_1-MLC",
    name: "Mistral 7B",
    sizeMB: 4000,
    tags: ["balanced", "mistral"],
    description: "A capable general-purpose 7B, if you have the memory for it.",
  },
];

function modelManifest(entry: (typeof FEATURED_MODELS)[number]): PluginManifest {
  return {
    id: `model:${entry.modelId}`,
    name: entry.name,
    description: entry.description,
    version: "1.0.0",
    category: "model",
    kind: "local-model",
    tags: ["local", "offline", ...entry.tags],
    license: "See model card",
    homepage: `https://huggingface.co/mlc-ai/${entry.modelId}`,
    estimatedSizeMB: entry.sizeMB,
    requires: ["webgpu"],
    config: { modelId: entry.modelId },
  };
}

/** Turn any WebLLM catalog id into a manifest, for the long tail. */
export function modelManifestFromId(modelId: string, vramMB?: number): PluginManifest {
  const pretty = modelId.replace(/-MLC$/, "").replace(/-q4f\d+_\d+$/, "").replace(/-/g, " ");
  return {
    id: `model:${modelId}`,
    name: pretty,
    description: "Runs entirely in your browser. No key, no quota, works offline once downloaded.",
    version: "1.0.0",
    category: "model",
    kind: "local-model",
    tags: ["local", "offline"],
    homepage: `https://huggingface.co/mlc-ai/${modelId}`,
    estimatedSizeMB: Math.round(vramMB ?? 0),
    requires: ["webgpu"],
    config: { modelId },
  };
}

/**
 * Tool plugins, generated from the same specs the loader registers, so the
 * store and the agent toolset can never disagree about what exists.
 */
const TOOL_ENTRIES: { id: string; name: string; description: string; tags: string[] }[] = [
  { id: "tool-regex", name: "Regex tester", tags: ["text", "regex", "developer"], description: "Test a regular expression against sample text and see every match with its capture groups." },
  { id: "tool-text-stats", name: "Text statistics", tags: ["text", "writing"], description: "Count characters, words, lines and estimate tokens for a block of text." },
  { id: "tool-diff", name: "Text diff", tags: ["text", "developer"], description: "Compare two blocks of text line by line and show exactly what changed." },
  { id: "tool-json", name: "JSON tools", tags: ["data", "json"], description: "Validate, format, minify or query JSON with a dotted path." },
  { id: "tool-csv", name: "CSV tools", tags: ["data", "csv"], description: "Parse CSV into an aligned table or convert it to JSON records." },
  { id: "tool-hash", name: "Hash and encode", tags: ["developer", "security"], description: "SHA-256/384/512 hashes plus base64 and hex encoding and decoding." },
  { id: "tool-uuid", name: "ID generator", tags: ["developer"], description: "Generate cryptographically random UUIDs and short ids." },
  { id: "tool-jwt", name: "JWT decoder", tags: ["developer", "auth"], description: "Decode a JWT header and payload for inspection. Does not verify the signature." },
  { id: "tool-color", name: "Colour tools", tags: ["design", "accessibility"], description: "Convert between hex, RGB and HSL, and check WCAG contrast between two colours." },
  { id: "tool-datetime", name: "Date and time", tags: ["time", "dates"], description: "Convert timestamps, measure date differences and format dates in any timezone." },
  { id: "tool-units", name: "Unit converter", tags: ["math", "units"], description: "Convert between length, mass, temperature, data and time units." },
];

const TOOLS: PluginManifest[] = TOOL_ENTRIES.map((t) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  version: "1.0.0",
  category: "tool",
  kind: "worker-tool",
  tags: t.tags,
  license: "MIT",
  // Bundled as one lazily-imported chunk, so nothing is fetched per tool.
  estimatedSizeMB: 0,
  config: { builtin: true },
}));

export const BUNDLED_CATALOG: PluginManifest[] = [
  ...RUNTIMES,
  ...TOOLS,
  ...FEATURED_MODELS.map(modelManifest),
];

/**
 * Every Python library this Pyodide build can install, read from the
 * self-hosted pyodide-lock.json rather than a list maintained here - so the
 * catalog cannot offer something Pyodide would fail to install, and it follows
 * a Pyodide upgrade for free.
 *
 * No size is shown: the lock carries none, and asking the CDN for ~356
 * Content-Lengths to fill a column is precisely the per-entry fan-out the store
 * is not allowed to do. The real figures appear per wheel during the install.
 */
async function pythonPackageManifests(): Promise<PluginManifest[]> {
  const { loadPyodidePackages, installablePackages } = await import("../python/packages");
  const { PACKAGE_DESCRIPTIONS } = await import("../python/packageDescriptions");
  return installablePackages(await loadPyodidePackages()).map((pkg) => ({
    id: `py-${pkg.name.toLowerCase()}`,
    name: pkg.name,
    description:
      PACKAGE_DESCRIPTIONS[pkg.name] ??
      (pkg.depends.length > 0
        ? `No description yet. Depends on ${pkg.depends.slice(0, 3).join(", ")}${
            pkg.depends.length > 3 ? ` and ${pkg.depends.length - 3} more` : ""
          }.`
        : "No description yet. Has no further dependencies."),
    version: pkg.version,
    category: "package" as const,
    kind: "python-package" as const,
    tags: ["python", ...pkg.imports.slice(0, 4)],
    runtime: "python",
    dependsOn: pkg.depends,
    provides: pkg.imports,
    homepage: `https://pypi.org/project/${pkg.name}/`,
    estimatedSizeMB: 0,
    config: { packageName: pkg.name },
  }));
}

/**
 * The full catalog: the bundled entries, every remaining WebLLM model, and the
 * Python package index - the last two loaded lazily so opening the store pulls
 * in neither the 6 MB runtime nor the lock file until it has to.
 */
export async function buildCatalog(): Promise<PluginManifest[]> {
  const [models, packages] = await Promise.all([
    (async () => {
      try {
        const { prebuiltAppConfig } = await import("@mlc-ai/web-llm");
        const featured = new Set(BUNDLED_CATALOG.map((m) => m.id));
        return prebuiltAppConfig.model_list
          .map((m) => modelManifestFromId(m.model_id, m.vram_required_MB))
          .filter((m) => !featured.has(m.id));
      } catch {
        // Offline, or WebGPU absent: the bundled entries still work.
        return [];
      }
    })(),
    (async () => {
      try {
        return await pythonPackageManifests();
      } catch {
        // The lock file is only reachable once the Python runtime's assets are
        // served; without it the rest of the store is unaffected.
        return [];
      }
    })(),
  ]);
  return [...BUNDLED_CATALOG, ...models, ...packages];
}
