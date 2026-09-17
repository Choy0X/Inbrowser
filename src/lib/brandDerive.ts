/**
 * The brand strings, derived once.
 *
 * Every value here used to be computed twice from the same `config.json` `app`
 * section: `HTML_BRAND_VARS` in vite.config.ts filled the `__APP_*__` tokens in
 * index.html, and appConfig.ts exported the same five strings to the bundle.
 * The two agreed by hand. That was survivable while there was one title and one
 * canonical URL; per-route heads multiply the chance they drift, and a drifted
 * canonical is the kind of SEO bug nobody notices for a quarter.
 *
 * WHY THIS FILE TAKES THE CONFIG AS AN ARGUMENT AND IMPORTS NOTHING. It has two
 * callers in two worlds that cannot share an import:
 *
 *   - `src/lib/appConfig.ts`, in the browser bundle, which may never import
 *     config.json (it carries the relay secret) and instead reads the
 *     `__APP_CONFIG__` define;
 *   - `vite.config.ts`, in Node, where `__APP_CONFIG__` does not exist and
 *     config.json is imported directly.
 *
 * A module that reached for either one would be importable by only one of them.
 * Taking the object as a parameter makes it importable by both, and by the
 * verify scripts besides. `verify:seo` asserts the two callers produce
 * identical values, so the duplication cannot quietly come back.
 */

/** config.json's `app` section. */
export interface BrandInput {
  name: string;
  slug: string;
  domain: string;
  titleSuffix: string;
  tagline: string;
  description: string;
  repoUrl: string;
  organizationName: string;
  logoPath: string;
  locale: string;
  twitterHandle: string;
}

export interface Brand {
  name: string;
  slug: string;
  domain: string;
  /** Origin, no trailing slash: "https://inbrowser.tech". */
  url: string;
  /** `<title>` and social-card title: "{name} - {titleSuffix}". */
  title: string;
  titleSuffix: string;
  tagline: string;
  description: string;
  ogImage: string;
  logoUrl: string;
  repoUrl: string;
  organizationName: string;
  /** BCP 47, for `<html lang>` and og:locale. */
  locale: string;
  /** Without the "@". Empty means: emit no twitter:site tag at all. */
  twitterHandle: string;
}

export function deriveBrand(app: BrandInput): Brand {
  const url = `https://${app.domain}`;
  return {
    name: app.name,
    slug: app.slug,
    domain: app.domain,
    url,
    title: `${app.name} - ${app.titleSuffix}`,
    titleSuffix: app.titleSuffix,
    tagline: app.tagline,
    description: app.description,
    ogImage: `${url}/og.png`,
    logoUrl: `${url}${app.logoPath}`,
    repoUrl: app.repoUrl,
    organizationName: app.organizationName,
    locale: app.locale,
    twitterHandle: app.twitterHandle,
  };
}

/** Absolute URL for an origin-relative route path. "/" yields the bare origin. */
export function absoluteUrl(brand: Brand, path: string): string {
  return path === "/" ? `${brand.url}/` : `${brand.url}${path}`;
}
