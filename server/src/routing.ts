/**
 * Which file answers which URL, and with what status code.
 *
 * Imported by BOTH static.ts (production) and dev.ts (development). That is the
 * whole point of the file: the two used to disagree. Production answered every
 * unknown path with `index.html` at 200 and development did the same but never
 * guarded runtime-asset paths, so a 404 in one was a 200 in the other and a
 * redirect existed in neither. Anything that decides a status code now lives
 * here, once.
 *
 * WHY THIS DOES NOT IMPORT THE ROUTE TABLE. `src/lib/seo/routeTable.ts` carries
 * every route's prose, and this module is bundled into `server/dist/relay.cjs`
 * - the process that terminates TLS to providers and therefore handles API keys
 * in plaintext. Nothing belongs in that bundle that does not have to be there.
 * So routes are discovered through the `exists` callback instead: production
 * asks the filesystem whether the build emitted `dist/<segment>/index.html`,
 * development asks the route table directly (dev.ts may import from src/; it
 * already imports Vite, and it is excluded from the production bundle).
 * `verify:seo` asserts relay.cjs contains none of the route table's prose.
 *
 * The redirect pairs below are the one thing duplicated from the route table,
 * because they must survive without it. `verify:seo` asserts they match.
 */

export type Navigation =
  /** A permanent move. `to` is origin-relative. */
  | { kind: "redirect"; to: string }
  /** Serve `dist/<dir>/index.html`, or `dist/index.html` when `dir` is "". */
  | { kind: "shell"; dir: string }
  /** Serve `dist/404.html` with a real 404. */
  | { kind: "notfound" };

/** Must match SEO_REDIRECTS in src/lib/seo/routeTable.ts. */
export const ROUTE_REDIRECTS: Readonly<Record<string, string>> = {
  "/skills": "/library",
  "/plugins": "/store",
};

export const CHAT_PREFIX = "/chat/";
export const CHAT_DIR = "chat";

/**
 * One lowercase path segment: what a route directory may be called.
 *
 * This is also a security boundary, not only a tidiness rule. The pathname
 * handed to `resolveNavigation` comes from `new URL(...).pathname`, which does
 * NOT percent-decode, so a traversal attempt arrives as a literal
 * `/%2e%2e/config.json` and is rejected here on the `%`. A dot, a slash or a
 * backslash cannot match either. Callers still resolve and containment-check
 * the final path, because one guard for this is not enough.
 */
const ROUTE_SEGMENT = /^\/[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Decide what a request path should be answered with.
 *
 * Callers must apply the runtime-asset and API guards BEFORE calling this - a
 * missing engine asset has to come back as a non-HTML 404 or the browser
 * reports it as a WebAssembly.CompileError starting `<!do`, with nothing
 * pointing back at the server. See static.ts.
 *
 * @param exists Whether a route shell exists for a bare segment, e.g. "library".
 */
export function resolveNavigation(
  pathname: string,
  exists: (dir: string) => boolean,
): Navigation {
  const moved = ROUTE_REDIRECTS[pathname];
  if (moved) return { kind: "redirect", to: moved };

  // `/library/` and `/library` are the same page; one of them has to be the
  // canonical or they compete with each other in the index.
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return { kind: "redirect", to: pathname.slice(0, -1) };
  }

  if (pathname === "/") return { kind: "shell", dir: "" };

  // Every conversation is private, local-only data; they all share one
  // non-indexable shell rather than getting a per-id document.
  if (pathname === "/chat" || pathname.startsWith(CHAT_PREFIX)) {
    return { kind: "shell", dir: CHAT_DIR };
  }

  if (ROUTE_SEGMENT.test(pathname)) {
    const dir = pathname.slice(1);
    if (exists(dir)) return { kind: "shell", dir };
  }

  return { kind: "notfound" };
}
