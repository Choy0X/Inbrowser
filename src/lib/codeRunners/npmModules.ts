import * as esbuild from "esbuild-wasm";
import wasmUrl from "esbuild-wasm/esbuild.wasm?url";

/**
 * Bare-specifier resolution for the JS/TS code runners.
 *
 * `esbuild.transform()` (what typescriptWorker.ts used before this) only
 * rewrites syntax - it never resolves or bundles a module graph. `build()`
 * does, via the same `esbuild.initialize()` call already made for `transform`,
 * and this module owns that init so neither worker has to.
 *
 * Every non-relative import falls into exactly one bucket:
 *
 *  - HAND_SHIMMED: needs a worker global (input(), fetch, per-run state) a
 *    generic polyfill can't provide - readline, process, fs, http(s). Left
 *    `external` so the bundled output's own `require("fs")` call reaches
 *    moduleShims.ts at runtime, unchanged from how readline worked before.
 *  - NODE_BUILTIN_POLYFILLS: everything else Node-shaped that already has a
 *    well-known, pure-JS browser polyfill (the same node-libs-browser mapping
 *    webpack/browserify have used for years) - resolved through the exact
 *    same CDN path as any npm package below, no bespoke code per built-in.
 *  - UNSUPPORTED: net, child_process, dns, ... - genuinely impossible without
 *    real sockets/processes. Failed at *build* time with a clear message
 *    naming the import, instead of a bare runtime ReferenceError.
 *  - anything else is treated as `<name>[@version]` and resolved to
 *    `https://esm.sh/<name>` - a CDN that itself resolves a package's
 *    transitive dependencies (and its own Node-builtin needs) into browser-
 *    ready ESM, which is what makes "most packages just work" realistic here
 *    without reimplementing Node module resolution.
 */

const HAND_SHIMMED_SPECIFIERS = new Set([
  "readline",
  "node:readline",
  "readline/promises",
  "node:readline/promises",
  "process",
  "node:process",
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "http",
  "node:http",
  "https",
  "node:https",
]);

function stripNodePrefix(specifier: string): string {
  return specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
}

/** The node-libs-browser mapping: Node built-in name -> its standard browser polyfill package. */
const NODE_BUILTIN_POLYFILLS: Record<string, string> = {
  path: "path-browserify",
  buffer: "buffer",
  events: "events",
  util: "util",
  assert: "assert",
  stream: "stream-browserify",
  crypto: "crypto-browserify",
  os: "os-browserify",
  querystring: "querystring-es3",
  url: "url",
  string_decoder: "string_decoder",
  punycode: "punycode",
  zlib: "browserify-zlib",
  timers: "timers-browserify",
  constants: "constants-browserify",
};

const UNSUPPORTED_SPECIFIERS = new Set([
  "net",
  "dgram",
  "child_process",
  "cluster",
  "dns",
  "tls",
  "worker_threads",
  "vm",
]);

const NPM_CACHE_NAME = "fachoy-plugin-npm";

/**
 * Cache-first fetch scoped to the npm CDN cache only - unlike
 * `runtimeCacheFetch.ts`'s `installCacheFirstFetch`, this never monkey-patches
 * the worker's global `fetch`, so the http/https shim's own requests (real,
 * one-off network calls a script makes on purpose) are never silently cached.
 */
async function cacheFirstFetch(url: string, onMiss: () => void): Promise<Response> {
  let cache: Cache | undefined;
  try {
    cache = await caches.open(NPM_CACHE_NAME);
    const cached = await cache.match(url);
    if (cached) return cached;
  } catch {
    /* Cache Storage unavailable - fall through to a normal network fetch */
  }
  onMiss();
  const response = await fetch(url);
  if (cache && response.ok) {
    try {
      void cache.put(url, response.clone());
    } catch {
      /* quota exceeded or an opaque response - serving it still works */
    }
  }
  return response;
}

function loaderForContentType(contentType: string): esbuild.Loader {
  if (contentType.includes("json")) return "json";
  // A package's optional stylesheet import has no meaning in a Worker with no
  // DOM - "empty" drops it rather than failing the whole build over it.
  if (contentType.includes("css")) return "empty";
  return "js";
}

/**
 * The one plugin: resolves the entry script's own bare imports (built-ins,
 * polyfills, npm packages), then recursively resolves whatever the resulting
 * CDN modules import themselves - mirrors esbuild's own documented "http-url"
 * plugin example almost exactly, since that is precisely this shape of
 * problem (fetch-and-bundle from a URL rather than a filesystem).
 */
function createNpmResolverPlugin(onStatus: (line: string) => void): esbuild.Plugin {
  return {
    name: "npm-cdn-resolver",
    setup(build) {
      // The entry script's own top-level bare imports.
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        const specifier = args.path;
        if (HAND_SHIMMED_SPECIFIERS.has(specifier)) {
          return { path: specifier, external: true };
        }
        const bare = stripNodePrefix(specifier);
        if (UNSUPPORTED_SPECIFIERS.has(bare)) {
          return {
            errors: [
              {
                text:
                  `Cannot import "${specifier}": there is no real network/process access for this in a browser ` +
                  "sandbox (no raw sockets or child processes). Use fetch() or the http/https shim instead.",
              },
            ],
          };
        }
        const target = NODE_BUILTIN_POLYFILLS[bare] ?? specifier;
        return { path: `https://esm.sh/${target}`, namespace: "cdn-npm" };
      });

      // Whatever a CDN-fetched module imports in turn - relative chunk paths,
      // origin-relative paths, another absolute URL, or (rarely) a bare name.
      build.onResolve({ filter: /.*/, namespace: "cdn-npm" }, (args) => {
        if (/^https?:\/\//.test(args.path)) return { path: args.path, namespace: "cdn-npm" };
        try {
          return { path: new URL(args.path, args.importer).href, namespace: "cdn-npm" };
        } catch {
          return { path: `https://esm.sh/${args.path}`, namespace: "cdn-npm" };
        }
      });

      build.onLoad({ filter: /.*/, namespace: "cdn-npm" }, async (args) => {
        const response = await cacheFirstFetch(args.path, () =>
          onStatus(`Fetching ${args.path.replace(/^https:\/\/esm\.sh\//, "")}...`)
        );
        if (!response.ok) {
          return { errors: [{ text: `Failed to fetch ${args.path}: HTTP ${response.status}` }] };
        }
        const contentType = response.headers.get("content-type") ?? "";
        return { contents: await response.text(), loader: loaderForContentType(contentType) };
      });
    },
  };
}

let esbuildReady: Promise<void> | null = null;
function initEsbuild(): Promise<void> {
  if (!esbuildReady) esbuildReady = esbuild.initialize({ wasmURL: wasmUrl, worker: false });
  return esbuildReady;
}

/**
 * The one entry point both workers call. `stdin` (an in-memory source string)
 * plus `bundle: true` is esbuild's standard technique for bundling code that
 * was never written to a real file - there is no filesystem in this sandbox.
 */
export async function bundleScript(code: string, loader: "ts" | "js", onStatus: (line: string) => void): Promise<string> {
  await initEsbuild();
  const result = await esbuild.build({
    stdin: { contents: code, loader, sourcefile: "input" },
    bundle: true,
    format: "cjs",
    target: "es2022",
    write: false,
    plugins: [createNpmResolverPlugin(onStatus)],
  });
  return result.outputFiles[0].text;
}
