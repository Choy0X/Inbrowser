/**
 * Serving the built client, and the SPA fallback.
 *
 * Registered after the API routes so `/v1/fetch` and `/health` always win. Three
 * things here are less obvious than they look.
 *
 * `wildcard: false` makes @fastify/static glob the build output and register a
 * route per file instead of one catch-all. With a catch-all, everything unknown
 * is answered by the static plugin and `setNotFoundHandler` never runs, so the
 * SPA fallback and its guards below would be dead code.
 *
 * `index: false` is what keeps directory paths falling through to that handler.
 * The build emits one shell per route at `dist/<route>/index.html`, so with
 * directory indexes enabled the static plugin would answer `/library` itself and
 * the redirect and 404 logic below would again be unreachable.
 *
 * The fallback refuses two families of path rather than answering everything
 * with index.html, which is what the old server.mjs did. See the comments on
 * each guard - the runtime-asset one in particular prevents a failure that is
 * genuinely hard to trace back here. Everything after those guards is decided by
 * `resolveNavigation`, which dev.ts also calls, because the two used to disagree
 * about status codes.
 */
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { isApiPath, isRuntimeAssetPath, type RelayConfig } from "./config.ts";
import { resolveNavigation } from "./routing.ts";

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Files a crawler asks for by name; short TTL so a deploy propagates quickly. */
const CRAWLER_FILES = new Set(["/robots.txt", "/sitemap.xml", "/llms.txt"]);

/**
 * Cache policy by path.
 *
 * Runtime assets and hashed build output never change under their own URL, so
 * they are immutable. server.mjs marked only /pyodide/ and /cpp/ that way and
 * left /php/, /ruby/ and /r/ uncached for no stated reason; all five get it now.
 * index.html must not be cached or a deploy never reaches anyone.
 */
function cacheControlFor(pathname: string): string {
  if (isRuntimeAssetPath(pathname)) return IMMUTABLE;
  if (pathname.startsWith("/assets/")) return IMMUTABLE;
  if (pathname === "/" || pathname.endsWith(".html")) return "no-cache";
  if (pathname === "/sw.js" || pathname === "/registerSW.js") return "no-cache";
  if (CRAWLER_FILES.has(pathname)) return "public, max-age=3600, must-revalidate";
  return "public, max-age=3600";
}

export async function registerStatic(app: FastifyInstance, config: RelayConfig): Promise<void> {
  await app.register(fastifyStatic, {
    root: config.distDir,
    // See the header comment: a catch-all would make the fallback unreachable.
    wildcard: false,
    index: false,
    // Range support, which server.mjs did not have. It matters: clang.wasm is
    // 42.5 MB and a browser that has to restart the download without ranges
    // starts from zero.
    acceptRanges: true,
    cacheControl: false,
    // This is handed a FastifyReply, not a raw ServerResponse.
    setHeaders(reply, path) {
      const rel = path.slice(config.distDir.length).replace(/\\/g, "/");
      reply.header("Cache-Control", cacheControlFor(rel));

      // Every route shell exists on disk twice over as far as a URL is
      // concerned: `dist/library/index.html` answers both `/library` (through
      // the fallback, the canonical form) and `/library/index.html` (here,
      // because wildcard:false registered a route for the real file). The two
      // would compete in the index. A route cannot simply be redirected -
      // @fastify/static has already claimed that path and Fastify refuses a
      // duplicate - so the direct-file form is told not to be indexed instead,
      // and the self-referential canonical inside the document names the form
      // that should be. `/` is served by the fallback and never reaches here.
      if (rel.endsWith(".html")) reply.header("X-Robots-Tag", "noindex");
    },
  });

  app.setNotFoundHandler(async (request, reply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;

    // A missing runtime asset must NOT come back as HTML. The engine receives
    // it as a wasm module and fails with a WebAssembly.CompileError whose first
    // bytes are `<!do`, with nothing pointing back at the server. See the note
    // on the exhaustive asset lists in vite.config.ts. This stays first.
    if (isRuntimeAssetPath(pathname)) {
      return reply
        .code(404)
        .type("text/plain; charset=utf-8")
        .header("Cache-Control", "no-store")
        .send("Runtime asset not found. Run `npm run build`.");
    }

    // The relay owns these. A wrong method or a typo must not be answered with a
    // 200 page - which is exactly what the old unconditional fallback did, so a
    // same-origin POST /v1/fetch would have returned 200 text/html.
    if (isApiPath(pathname)) {
      return reply.code(404).header("Cache-Control", "no-store").send({ error: "Not found" });
    }

    const nav = resolveNavigation(pathname, (dir) => existsSync(shellPath(config, dir)));

    switch (nav.kind) {
      case "redirect":
        // 301, not 302: these are permanent, and a temporary redirect would keep
        // the old URL in the index and pass none of its ranking to the new one.
        return reply
          .code(301)
          .header("Location", nav.to)
          .header("Cache-Control", "public, max-age=3600")
          .send();
      case "shell":
        return sendShell(reply, config, nav.dir);
      case "notfound":
        return sendNotFound(reply, config);
    }
  });
}

/**
 * `dist/<dir>/index.html`, or `dist/index.html` for the root.
 *
 * `dir` reaches here only from `resolveNavigation`, which accepts one lowercase
 * path segment and nothing containing a dot, a slash or a percent sign. The
 * containment check below is the second lock on the same door: cheap, and the
 * consequence of being wrong is serving any file on the box.
 */
function shellPath(config: RelayConfig, dir: string): string {
  const full = resolve(config.distDir, dir, "index.html");
  const root = resolve(config.distDir);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`refusing to serve outside distDir: ${dir}`);
  }
  return full;
}

/** The SPA entry point. Read per request so a rebuild is picked up without a restart. */
export function sendIndex(reply: FastifyReply, config: RelayConfig): FastifyReply {
  return sendShell(reply, config, "");
}

/**
 * A route's pre-rendered shell.
 *
 * Falls back to the root shell when a route directory is missing, so a `dist/`
 * built before the per-route shells existed still serves every URL rather than
 * 404ing the whole app. Cache-Control is hardcoded rather than taken from
 * `cacheControlFor`, as `sendIndex` always did: what is served here is chosen by
 * request path, not by file path, so the file's own policy is not the question.
 */
export function sendShell(reply: FastifyReply, config: RelayConfig, dir: string): FastifyReply {
  for (const candidate of dir ? [shellPath(config, dir), shellPath(config, "")] : [shellPath(config, "")]) {
    try {
      const html = readFileSync(candidate, "utf8");
      return reply
        .code(200)
        .type("text/html; charset=utf-8")
        .header("Cache-Control", "no-cache")
        .send(html);
    } catch {
      /* try the next candidate */
    }
  }
  return reply
    .code(404)
    .type("text/plain; charset=utf-8")
    .header("Cache-Control", "no-store")
    .send("dist not built. Run `npm run build` first.");
}

/**
 * A real 404, with a real page.
 *
 * Every unknown path used to return 200 with the app shell, and the client
 * router then redirected it to `/`. Search engines call that a soft 404: the
 * URL looks like a working page, so it gets crawled and considered for indexing
 * forever. Answering 404 is what stops that, and `dist/404.html` is what makes
 * the answer readable to a person as well as to a crawler.
 */
function sendNotFound(reply: FastifyReply, config: RelayConfig): FastifyReply {
  reply.code(404).header("Cache-Control", "no-store");
  try {
    return reply
      .type("text/html; charset=utf-8")
      .send(readFileSync(join(config.distDir, "404.html"), "utf8"));
  } catch {
    // A dist/ built before the 404 shell existed, or no dist/ at all.
    return reply.type("text/plain; charset=utf-8").send("Not found");
  }
}
