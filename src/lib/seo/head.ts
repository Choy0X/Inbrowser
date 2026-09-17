/**
 * Keeping the document head in step with the route, after React has mounted.
 *
 * The build emits a correct head for every URL, so a crawler and a link-preview
 * bot always get the right title without this file existing at all. What this
 * covers is the case they never see: a visitor already inside the app who
 * navigates with the client router, where the document is never re-fetched and
 * the head would otherwise keep describing the page they arrived on. That
 * matters for the browser tab, for bookmarks, and for anything that reads the
 * live DOM.
 *
 * WHAT THIS DELIBERATELY DOES NOT TOUCH: the JSON-LD block. Every crawler
 * fetches each URL fresh and gets the build-time graph, which is correct by
 * construction. Rewriting it on client navigation would add a second source of
 * truth whose only possible contribution is disagreeing with the first.
 *
 * The find-or-create helper follows `applyThemeColor` in src/lib/theme.ts, which
 * is the existing precedent for mutating the head at runtime.
 */

import { APP_NAME, APP_TITLE, APP_URL } from "../appConfig";
import { SEO_CHAT_PREFIX, SEO_NOT_FOUND_PATH, SEO_ROUTES, seoRouteFor, type SeoRoute } from "./routeTable";

export interface ResolvedSeo {
  route: SeoRoute;
  title: string;
  canonical: string;
  robots: string;
}

const INDEXABLE_ROBOTS = "index, follow, max-image-preview:large, max-snippet:-1";
const BLOCKED_ROBOTS = "noindex, nofollow";

/**
 * Which route's metadata a pathname should carry.
 *
 * Mirrors `resolveNavigation` in server/src/routing.ts: every `/chat/<id>` maps
 * to the one non-indexable chat entry, and anything unrecognised maps to the 404
 * entry. It does not import that module - the server's copy must stay free of
 * anything under src/, since it is bundled into the process that handles
 * provider keys - so `verify:seo` asserts the two agree instead.
 */
export function resolveRouteSeo(pathname: string): ResolvedSeo {
  const route =
    seoRouteFor(pathname) ??
    (pathname === "/chat" || pathname.startsWith(SEO_CHAT_PREFIX) ? seoRouteFor("/chat") : undefined) ??
    seoRouteFor(SEO_NOT_FOUND_PATH) ??
    SEO_ROUTES[0];

  return {
    route,
    title: route.title ? `${route.title} - ${APP_NAME}` : APP_TITLE,
    canonical: route.path === "/" ? `${APP_URL}/` : `${APP_URL}${route.path}`,
    robots: route.indexable ? INDEXABLE_ROBOTS : BLOCKED_ROBOTS,
  };
}

function upsertMeta(selector: string, create: () => HTMLMetaElement, content: string): void {
  let meta = document.querySelector<HTMLMetaElement>(selector);
  if (!meta) {
    meta = create();
    document.head.appendChild(meta);
  }
  meta.content = content;
}

function named(name: string, content: string): void {
  upsertMeta(`meta[name="${name}"]`, () => {
    const m = document.createElement("meta");
    m.name = name;
    return m;
  }, content);
}

function property(prop: string, content: string): void {
  upsertMeta(`meta[property="${prop}"]`, () => {
    const m = document.createElement("meta");
    m.setAttribute("property", prop);
    return m;
  }, content);
}

/** Apply a route's metadata to the live document. */
export function applyRouteSeo(pathname: string): ResolvedSeo {
  const seo = resolveRouteSeo(pathname);
  if (typeof document === "undefined") return seo;

  document.title = seo.title;
  named("description", seo.route.description);
  named("robots", seo.robots);
  property("og:title", seo.title);
  property("og:description", seo.route.description);
  property("og:url", seo.canonical);
  named("twitter:title", seo.title);
  named("twitter:description", seo.route.description);

  let link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (seo.route.indexable) {
    if (!link) {
      link = document.createElement("link");
      link.rel = "canonical";
      document.head.appendChild(link);
    }
    link.href = seo.canonical;
  } else if (link) {
    // A canonical asks for this URL to be indexed under that name, which
    // contradicts the noindex directive set above. Remove it rather than leave
    // the two arguing.
    link.remove();
  }

  return seo;
}
