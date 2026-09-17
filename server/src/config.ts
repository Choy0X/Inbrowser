/**
 * The server's configuration.
 *
 * Read from `config.json` at the repo root - the same file the client's brand
 * and behaviour come from - with every value overridable by an environment
 * variable. Precedence is env > config.json > built-in default.
 *
 * Read at RUNTIME rather than imported, deliberately. Importing would inline the
 * whole file into the esbuild bundle, so the relay secret would be baked into
 * the deployed artifact and changing a port would need a rebuild. Reading it
 * means config.json ships next to server/dist/relay.cjs and a restart is enough.
 *
 * Only this file and vite.config.ts ever read config.json. Nothing under `src/`
 * may import it: the `server` section holds the relay secret, and a JSON import
 * from client code would publish it to every visitor. See the header of
 * src/lib/appConfig.ts.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface RelayConfig {
  port: number;
  /** `wss://...` address of the Cloudflare Worker that dials proxies. */
  workerUrl: string;
  /** Shared with the Worker. Without it every proxied request returns 503. */
  relaySecret: string;
  /**
   * Origins allowed to call the relay route. Empty is the normal case and means
   * no CORS headers are emitted at all, because the client is served from this
   * same origin. Non-empty exists only for a deployment whose client lives
   * somewhere else.
   */
  allowedOrigins: string[];
  maxBodyBytes: number;
  rateLimitPerMinute: number;
  /** Directory holding the built client. */
  distDir: string;
  dev: boolean;
  /**
   * Opt-in, off by default. When set, `handleRelay` and `openTunnel` emit a
   * single structured JSON line per failure naming which site fired and a
   * non-identifying category/duration - never the target, headers, proxy or
   * dial content. Exists to root-cause a relay failure without weakening the "logs
   * nothing" claim in the normal case.
   */
  debugLog: boolean;
}

/**
 * The repo root. Taken from the working directory rather than this file's own
 * location, because the production artifact is a CJS bundle and `import.meta.url`
 * is not available there. Running from the repo root is already required anyway:
 * vite.config.ts's patchPhpWasmGluePlugin and runtimeManifestPlugin both resolve
 * against process.cwd(). One rule, not two.
 */
const ROOT = process.cwd();

interface ServerSection {
  port?: number;
  devPort?: number;
  workerUrl?: string;
  relaySecret?: string;
  allowedOrigins?: string[];
  maxBodyBytes?: number;
  rateLimitPerMinute?: number;
  distDir?: string;
}

function readServerSection(): ServerSection {
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8")) as {
      server?: ServerSection;
    };
    return parsed.server ?? {};
  } catch {
    // A missing or unreadable config.json is not fatal: every value has a
    // default and the environment can supply the rest. The case that actually
    // matters, an unusable relay secret, is reported at startup by index.ts.
    return {};
  }
}

function intFrom(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * True when the relay secret is missing or is obviously a placeholder.
 *
 * config.json is committed, so a secret written into it is public. Accepting one
 * would give the appearance of authentication with none of it - the Worker would
 * accept dials from anyone who read the repo. So the server refuses to enable
 * proxying and says why, rather than running in a state that looks configured.
 *
 * `deriveDialKey` independently rejects anything under 32 characters, so a short
 * placeholder would fail at first use anyway; this catches it at startup, and
 * catches a long-but-obviously-fake one too.
 */
export function isPlaceholderSecret(secret: string): boolean {
  const trimmed = secret.trim();
  if (trimmed.length < 32) return true;
  const squashed = trimmed.replace(/[-_\s]/g, "").toLowerCase();
  return /^(example|changeme|placeholder|yoursecret|replaceme|x+|0+|a+)$/.test(squashed);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const dev = env.NODE_ENV !== "production";
  const file = readServerSection();

  // 5173 in dev and 4173 in production keep the ports this project has always
  // used, so anything pointing at them - a reverse proxy, a bookmark - still
  // works now that the two servers became one.
  const filePort = dev ? file.devPort : file.port;

  const originsFromEnv = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : null;

  const distDir = env.DIST_DIR || file.distDir || "";

  return {
    port: intFrom(env.PORT, filePort ?? (dev ? 5173 : 4173)),
    workerUrl: env.WORKER_URL || file.workerUrl || "",
    relaySecret: env.RELAY_SECRET || file.relaySecret || "",
    allowedOrigins: originsFromEnv ?? file.allowedOrigins ?? [],
    maxBodyBytes: intFrom(env.MAX_BODY_BYTES, file.maxBodyBytes ?? 32 * 1024 * 1024),
    rateLimitPerMinute: intFrom(env.RATE_LIMIT_PER_MINUTE, file.rateLimitPerMinute ?? 120),
    distDir: distDir ? resolve(distDir) : join(ROOT, "dist"),
    dev,
    debugLog: env.RELAY_DEBUG_LOG === "1",
  };
}

export const VERSION = "1.0.0";

/**
 * Prefixes under which the big in-browser language runtimes are served.
 *
 * Load-bearing in two places: these paths get immutable caching, and the SPA
 * fallback must refuse them. A missing runtime asset answered with index.html
 * reaches the engine as HTML and surfaces as a WebAssembly.CompileError whose
 * first bytes are `<!do` - see the note in vite.config.ts on why the asset lists
 * there are exhaustive.
 */
export const RUNTIME_ASSET_PREFIXES = ["/pyodide/", "/php/", "/ruby/", "/r/", "/cpp/"];

/** Paths the relay owns. The SPA fallback must never answer these with HTML. */
export const API_PREFIXES = ["/v1/", "/health"];

export function isRuntimeAssetPath(pathname: string): boolean {
  return RUNTIME_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}
