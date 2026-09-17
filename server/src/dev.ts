/**
 * Development: Vite as middleware inside Fastify, on one port.
 *
 * Two things here are easy to get wrong and both fail quietly.
 *
 * `appType: "custom"` means Vite does NOT serve index.html - that is the whole
 * point of it, since Fastify owns routing. The consequence is that this file
 * must run `transformIndexHtml` itself. Skip it and the page renders with a
 * literal `__APP_NAME__` in the title, because htmlBrandPlugin is a
 * transformIndexHtml hook and nothing else will ever call it.
 *
 * HMR attaches to Fastify's own server, so there is one port and one process
 * rather than a Vite dev server alongside. That is what `hmr: { server }` does;
 * without it Vite would try to open a second port for its websocket.
 *
 * Vite is imported dynamically so the production bundle never pulls the whole
 * dev toolchain in - esbuild would otherwise follow the import and bundle it.
 *
 * Routing decisions come from ./routing.ts, the same module static.ts uses, so
 * `npm run dev` and `npm start` return the same status code for the same URL.
 * They did not before: production answered every unknown path with a 200 shell
 * and development did the same but never guarded runtime assets, so a bug that
 * only appears as a 404 was invisible in dev.
 */
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { isApiPath, isRuntimeAssetPath, type RelayConfig } from "./config.ts";
import { resolveNavigation } from "./routing.ts";

/** Repo root, where index.html and vite.config.ts live. */
function rootOf(config: RelayConfig): string {
  return join(config.distDir, "..");
}

export async function attachVite(app: FastifyInstance, config: RelayConfig): Promise<void> {
  const [{ createServer }, middie] = await Promise.all([
    import("vite"),
    import("@fastify/middie").then((m) => m.default),
  ]);

  const root = rootOf(config);

  // vite-plugin-monaco-editor clears its own cache with
  // `fs.rmdirSync(dir, { recursive: true })`, which Node removed - so it throws
  // on startup whenever that directory already exists. The repo's `predev`
  // script works around it by deleting the directory before `npm run dev`, but
  // that only covers the first start: `node --watch` restarts on every server
  // edit without re-running predev, and the second restart would crash. Doing it
  // here makes the dev loop work regardless of how the process was launched.
  rmSync(join(root, "node_modules/.monaco"), { recursive: true, force: true });

  const vite = await createServer({
    root,
    appType: "custom",
    server: {
      middlewareMode: true,
      // Fastify owns the port; Vite's websocket rides on the same server.
      hmr: { server: app.server },
    },
  });

  await app.register(middie);

  // Everything Vite handles - module graph, HMR, the configureServer middlewares
  // that serve the runtime manifests and stamp COEP on Monaco's workers - comes
  // through here. The API routes are already registered, so they are matched
  // first and never reach this.
  app.use(vite.middlewares);

  /**
   * Which routes exist, asked of the route table itself.
   *
   * Production answers this from the filesystem, because the build emits one
   * shell per route; in development nothing has been emitted yet, so the table
   * is the only source. It is loaded through Vite's own SSR module graph rather
   * than imported, and that is deliberate: `import("./dev.ts")` in index.ts is a
   * relative specifier, so esbuild follows it and bundles this file into
   * server/dist/relay.cjs. A static import of anything under src/ would drag the
   * route table's prose into the process that handles provider API keys in
   * plaintext. A string handed to ssrLoadModule is invisible to esbuild.
   * `verify:seo` asserts relay.cjs stays free of it.
   */
  const routeDirs = async (): Promise<Set<string>> => {
    const mod = (await vite.ssrLoadModule("/src/lib/seo/routeTable.ts")) as {
      SEO_ROUTES: { path: string }[];
    };
    return new Set(mod.SEO_ROUTES.map((r) => r.path.replace(/^\//, "")));
  };

  app.setNotFoundHandler(async (request, reply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;

    // Same guard as production, and in the same order: a missing runtime asset
    // must not come back as HTML or the engine reports it as a
    // WebAssembly.CompileError starting `<!do`. See static.ts.
    if (isRuntimeAssetPath(pathname)) {
      return reply
        .code(404)
        .type("text/plain; charset=utf-8")
        .send("Runtime asset not found.");
    }

    // Same guard as production: the relay's paths must never answer with HTML.
    if (isApiPath(pathname)) {
      return reply.code(404).send({ error: "Not found" });
    }

    try {
      const dirs = await routeDirs();
      const nav = resolveNavigation(pathname, (dir) => dirs.has(dir));

      if (nav.kind === "redirect") {
        return reply.code(301).header("Location", nav.to).send();
      }

      const raw = await readFile(join(root, "index.html"), "utf8");
      // Without this, htmlBrandPlugin and seoHtmlPlugin never run: both are
      // transformIndexHtml hooks and appType:"custom" means nothing else calls
      // them. seoHtmlPlugin reads the URL passed here to pick the route, which
      // is what makes dev serve the same per-route HTML the build emits.
      const url = nav.kind === "notfound" ? "/404" : request.url;
      const html = await vite.transformIndexHtml(url, raw);
      return reply
        .code(nav.kind === "notfound" ? 404 : 200)
        .type("text/html; charset=utf-8")
        .send(html);
    } catch (err) {
      vite.ssrFixStacktrace(err as Error);
      return reply.code(500).type("text/plain; charset=utf-8").send(String(err));
    }
  });

  app.addHook("onClose", async () => {
    await vite.close();
  });
}
