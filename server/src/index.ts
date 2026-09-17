/**
 * InBrowser's server. One process, one origin.
 *
 * It does two jobs and nothing else: it serves the built client, and it forwards
 * a proxied request to the Cloudflare Worker that dials the user's proxy (that
 * Worker is a separate repository, `inbrowser-relay`). There is exactly one API
 * route. Fastify is here to route and serve files - it is not a backend, and
 * nothing else belongs in it.
 *
 * Serving the client from the same origin as the relay is the reason this exists
 * at all: it removes CORS, the X-Relay-Meta preflight and the relay URL the
 * client would otherwise have to be told, and it puts the COOP/COEP headers that
 * interactive Pyodide depends on in one place instead of two that can drift.
 *
 * With no proxy configured, nothing here is on the path between the user and a
 * provider. The browser still calls providers directly, which is what keeps
 * their per-IP rate limits per-user.
 *
 * Deploy behind Cloudflare with proxied DNS. That is not optional advice: it
 * hides this host's address, and it edge-caches the ~113 MB of language-runtime
 * assets that would otherwise leave this server on every cold load.
 *
 * The invariants for the proxied path - no logging of request fields, nothing
 * persisted, no buffering, an allowlisted dependency set - are documented and
 * enforced in app.ts. Read that before changing anything here.
 */
import { buildApp } from "./app.ts";
import { isPlaceholderSecret, loadConfig } from "./config.ts";
import { registerStatic } from "./static.ts";

// Wrapped in main() rather than using top-level await: the production artifact
// is a CJS bundle (Fastify's dependencies do dynamic `require`s that esbuild's
// ESM output cannot satisfy), and CJS has no top-level await.
async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildApp(config);

  if (config.dev) {
    // Dynamic, and marked --external in the bundle, so the production artifact
    // never pulls in Vite and the whole dev toolchain behind it.
    const { attachVite } = await import("./dev.ts");
    await attachVite(app, config);
  } else {
    await registerStatic(app, config);
  }

  // A slow model can leave a stream idle for a long time; the real bound is the
  // per-request timeout in forward.ts. Headers should still arrive promptly.
  app.server.headersTimeout = 30_000;

  await app.listen({ port: config.port, host: "0.0.0.0" });

  // The only lines this process prints by default. See the logging rule in
  // app.ts; RELAY_DEBUG_LOG=1 opts into additional non-identifying failure
  // diagnostics there, off unless explicitly set.
  console.log(`InBrowser ${config.dev ? "dev" : "server"} listening on :${config.port}`);
  if (!config.workerUrl) {
    console.warn("No worker URL is set - proxied requests will return 503. See `server` in config.json.");
  } else if (isPlaceholderSecret(config.relaySecret)) {
    // config.json is committed, so a secret written into it is public, and a
    // public secret authenticates nobody. Saying so plainly beats running in a
    // state that looks configured and is not.
    console.warn(
      "The relay secret is unset or still a placeholder - proxied requests will fail. " +
        "Set RELAY_SECRET in the environment to the same value the worker was deployed " +
        "with; it has to match, not merely exist. Put it in the environment rather than " +
        "config.json, which is committed and therefore public."
    );
  }
}

void main();
