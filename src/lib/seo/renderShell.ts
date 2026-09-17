/**
 * The static HTML every route serves before React mounts.
 *
 * WHY THIS EXISTS AT ALL. The app is client-only, so `dist/index.html` shipped
 * `<div id="root"></div>` and nothing else - a crawler that does not execute
 * JavaScript saw a blank page on every URL. Server-side rendering would not
 * help: this app has no server-side data, so `renderToString` would faithfully
 * render an empty composer and an empty skill list. What a crawler actually
 * needs is a description of the page, and that is a build-time artifact.
 *
 * WHY THE BODY MARKUP IS SAFE TO PUT INSIDE `#root`. React 18's
 * `createRoot(container).render()` clears the container's existing children on
 * its first render. So this markup is read by crawlers, AI fetchers, link
 * preview bots and no-JS visitors, and is discarded the moment the bundle
 * mounts. It is `createRoot` specifically that permits this - `hydrateRoot`
 * would treat it as a hydration mismatch instead, which is why `verify:seo`
 * asserts main.tsx still uses `createRoot`.
 *
 * WHY THIS IS PLAIN STRING TEMPLATING AND NOT JSX. The build-time caller is
 * vite.config.ts, in Node, where there is no JSX runtime and importing
 * `react-dom/server` would pull React into the config graph for no reason. The
 * module also has to stay importable from the browser bundle, which rules out
 * anything Node-only. Plain strings satisfy both.
 *
 * ANTI-CLOAKING. Every word emitted here comes either from the route table or
 * from the same data modules the React views render (`seo/content/`). Nothing
 * is written twice, so the indexed copy and the visible copy cannot describe
 * different products. `verify:seo` additionally asserts each route's `h1`
 * appears in the component that renders the real page.
 */

import { FEATURE_GROUPS } from "./content/featureGroups";
import { privacyPolicySections } from "./content/privacyPolicy";
import type { SeoRoute, SeoSection } from "./routeTable";

/** Minimal shape of a changelog.json entry; read from disk by the build. */
export interface ShellChangelogEntry {
  version: string;
  date: string;
  items: string[];
}

/** The brand values the shell needs. Structurally a subset of `Brand`. */
export interface ShellBrand {
  name: string;
  url: string;
  title: string;
  description: string;
  tagline: string;
  ogImage: string;
  logoUrl: string;
  repoUrl: string;
  organizationName: string;
  locale: string;
  twitterHandle: string;
}

export interface ShellInput {
  route: SeoRoute;
  brand: ShellBrand;
  /** Every route, so each shell can link to the others. */
  allRoutes: SeoRoute[];
  /** Required only for the `/changelog` route. */
  changelog?: ShellChangelogEntry[];
}

export const SEO_HEAD_OPEN = "<!--seo:head-->";
export const SEO_HEAD_CLOSE = "<!--/seo:head-->";
export const SEO_BODY_OPEN = "<!--seo:body-->";
export const SEO_BODY_CLOSE = "<!--/seo:body-->";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * JSON embedded in a `<script>` needs `<` escaped or a `</script>` inside a
 * string ends the block early. `<` is valid JSON and valid JS.
 */
function escapeJsonLd(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/</g, "\\u003c");
}

export function absoluteFor(brand: ShellBrand, path: string): string {
  return path === "/" ? `${brand.url}/` : `${brand.url}${path}`;
}

/** The full document title for a route. The root uses the brand title as-is. */
export function titleFor(route: SeoRoute, brand: ShellBrand): string {
  return route.title ? `${route.title} - ${brand.name}` : brand.title;
}

// ---------------------------------------------------------------------------
// Head
// ---------------------------------------------------------------------------

export function renderShellHead(input: ShellInput): string {
  const { route, brand } = input;
  const title = titleFor(route, brand);
  const canonical = absoluteFor(brand, route.path);
  const lines: string[] = [];
  const meta = (attr: "name" | "property", key: string, content: string) =>
    lines.push(`<meta ${attr}="${key}" content="${escapeHtml(content)}" />`);

  lines.push(`<title>${escapeHtml(title)}</title>`);
  meta("name", "description", route.description);

  if (route.indexable) {
    lines.push(`<link rel="canonical" href="${escapeHtml(canonical)}" />`);
    meta("name", "robots", "index, follow, max-image-preview:large, max-snippet:-1");
  } else {
    // No canonical on a page that must not be indexed: a canonical is a request
    // to index this URL under that name, which contradicts the directive below.
    meta("name", "robots", "noindex, nofollow");
  }

  meta("property", "og:type", "website");
  meta("property", "og:site_name", brand.name);
  meta("property", "og:locale", brand.locale);
  meta("property", "og:url", canonical);
  meta("property", "og:title", title);
  meta("property", "og:description", route.description);
  meta("property", "og:image", brand.ogImage);
  meta("property", "og:image:width", "1200");
  meta("property", "og:image:height", "630");
  meta("property", "og:image:alt", `${brand.name} - ${brand.tagline}`);
  meta("name", "twitter:card", "summary_large_image");
  meta("name", "twitter:title", title);
  meta("name", "twitter:description", route.description);
  meta("name", "twitter:image", brand.ogImage);
  // A blank twitter:site is worse than none, so it is omitted entirely when the
  // handle is unset rather than emitted empty.
  if (brand.twitterHandle) meta("name", "twitter:site", `@${brand.twitterHandle}`);

  const graph = jsonLdGraph(input);
  if (graph) {
    lines.push(`<script type="application/ld+json">\n${escapeJsonLd(graph)}\n</script>`);
  }

  return lines.map((line) => `    ${line}`).join("\n");
}

// ---------------------------------------------------------------------------
// Structured data
// ---------------------------------------------------------------------------

function jsonLdGraph(input: ShellInput): Record<string, unknown> | null {
  const { route, brand } = input;
  if (route.jsonLd === "none") return null;

  const siteId = `${brand.url}/#website`;
  const orgId = `${brand.url}/#organization`;
  const canonical = absoluteFor(brand, route.path);

  const organization = {
    "@type": "Organization",
    "@id": orgId,
    name: brand.organizationName,
    url: `${brand.url}/`,
    logo: { "@type": "ImageObject", url: brand.logoUrl },
    sameAs: [brand.repoUrl],
  };

  const website = {
    "@type": "WebSite",
    "@id": siteId,
    url: `${brand.url}/`,
    name: brand.name,
    description: brand.description,
    inLanguage: brand.locale,
    publisher: { "@id": orgId },
  };

  if (route.jsonLd === "home") {
    return {
      "@context": "https://schema.org",
      "@graph": [
        website,
        organization,
        {
          "@type": "SoftwareApplication",
          "@id": `${brand.url}/#software`,
          name: brand.name,
          applicationCategory: "BrowserApplication",
          operatingSystem: "Any modern web browser",
          url: `${brand.url}/`,
          description: brand.description,
          inLanguage: brand.locale,
          isAccessibleForFree: true,
          publisher: { "@id": orgId },
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          featureList: FEATURE_GROUPS.flatMap((g) => g.features.map((f) => f.name)),
        },
      ],
    };
  }

  const graph: Record<string, unknown>[] = [
    website,
    organization,
    {
      "@type": "WebPage",
      "@id": `${canonical}#webpage`,
      url: canonical,
      name: titleFor(route, brand),
      description: route.description,
      inLanguage: brand.locale,
      isPartOf: { "@id": siteId },
      about: { "@id": orgId },
    },
    {
      "@type": "BreadcrumbList",
      "@id": `${canonical}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: brand.name, item: `${brand.url}/` },
        { "@type": "ListItem", position: 2, name: route.h1, item: canonical },
      ],
    },
  ];

  if (route.contentSource === "features") {
    graph.push({
      "@type": "ItemList",
      "@id": `${canonical}#features`,
      name: "Features",
      itemListElement: FEATURE_GROUPS.flatMap((group) =>
        group.features.map((feature) => ({
          "@type": "ListItem",
          name: feature.name,
          description: feature.description,
        })),
      ).map((item, i) => ({ ...item, position: i + 1 })),
    });
  }

  return { "@context": "https://schema.org", "@graph": graph };
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function sectionsFor(input: ShellInput): SeoSection[] {
  const { route, brand } = input;
  switch (route.contentSource) {
    case "features":
      return FEATURE_GROUPS.flatMap((group) =>
        group.features.map((feature) => ({
          heading: `${group.category}: ${feature.name}`,
          body: `${feature.description} ${feature.example}`,
        })),
      );
    case "privacy":
      return privacyPolicySections({
        name: brand.name,
        url: brand.url,
        repoUrl: brand.repoUrl,
      }).map((section) => ({
        heading: section.title,
        body: section.paragraphs.join(" "),
      }));
    case "changelog":
      return (input.changelog ?? []).map((entry) => ({
        heading: `Version ${entry.version} - ${entry.date}`,
        body: entry.items.join(" "),
      }));
    default:
      return route.sections;
  }
}

/**
 * The link graph. Before this existed the app had no `<a href>` anywhere at all
 * - navigation was entirely programmatic - so a crawler landing on the homepage
 * had no way to discover any other route. Every shell links to every other
 * indexable route, which makes the site connected from any entry point.
 */
function renderNav(input: ShellInput): string {
  const links = input.allRoutes
    .filter((r) => r.indexable && r.path !== input.route.path)
    .map(
      (r) =>
        `        <li><a href="${escapeHtml(r.path)}">${escapeHtml(r.h1)}</a> - ${escapeHtml(r.description)}</li>`,
    )
    .join("\n");

  return [
    `      <nav aria-label="Sections">`,
    `        <h2>More in ${escapeHtml(input.brand.name)}</h2>`,
    `      <ul>`,
    links,
    `      </ul>`,
    `      </nav>`,
  ].join("\n");
}

export function renderShellBody(input: ShellInput): string {
  const { route, brand } = input;
  const sections = sectionsFor(input);

  const parts: string[] = [];
  parts.push(`    <div data-seo-shell="${escapeHtml(route.path)}">`);
  parts.push(`      <h1>${escapeHtml(route.h1)}</h1>`);
  parts.push(`      <p>${escapeHtml(route.intro)}</p>`);

  for (const section of sections) {
    parts.push(`      <section>`);
    parts.push(`        <h2>${escapeHtml(section.heading)}</h2>`);
    parts.push(`        <p>${escapeHtml(section.body)}</p>`);
    parts.push(`      </section>`);
  }

  if (route.indexable) parts.push(renderNav(input));
  else {
    parts.push(
      `      <p><a href="/">${escapeHtml(brand.name)}</a></p>`,
    );
  }

  parts.push(`    </div>`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

function replaceBetween(html: string, open: string, close: string, content: string): string {
  const start = html.indexOf(open);
  const end = html.indexOf(close);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `index.html is missing the ${open}...${close} markers. The SEO shell generator ` +
        `replaces the content between them; without the markers it would append on every ` +
        `build instead. See src/lib/seo/renderShell.ts.`,
    );
  }
  return html.slice(0, start + open.length) + content + html.slice(end);
}

/**
 * Swap one route's head and body content into an HTML document.
 *
 * Idempotent by construction: it replaces what is between the markers rather
 * than appending, so the build can start from the already-emitted
 * `dist/index.html` - hashed asset references, the PWA manifest link and all -
 * and produce every other route's shell from it. That is what guarantees no
 * shell can reference a stale bundle. `verify:seo` proves it by re-running this
 * function over `dist/index.html` and comparing byte-for-byte.
 */
export function injectSeo(html: string, input: ShellInput): string {
  const withHead = replaceBetween(
    html,
    SEO_HEAD_OPEN,
    SEO_HEAD_CLOSE,
    `\n${renderShellHead(input)}\n    `,
  );
  const withBody = replaceBetween(
    withHead,
    SEO_BODY_OPEN,
    SEO_BODY_CLOSE,
    `\n${renderShellBody(input)}\n    `,
  );
  // The pre-paint guard and the SW-served-shell guard both key off this.
  return withBody.replace(
    /<div id="root"(?: data-seo-path="[^"]*")?>/,
    `<div id="root" data-seo-path="${escapeHtml(input.route.path)}">`,
  );
}
