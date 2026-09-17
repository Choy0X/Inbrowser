/**
 * The app's configuration, as the browser sees it.
 *
 * Everything comes from `config.json` at the repo root - one file for the whole
 * app, client and server. This module exposes only the parts a browser is
 * allowed to know.
 *
 * WHY THIS READS A `define` RATHER THAN IMPORTING THE JSON. `config.json` has a
 * `server` section holding, among other things, the relay secret. A plain
 * `import config from "../../config.json"` inlines the *entire file* into the
 * bundle - that is how the old `app.config.json` worked, and it is fine for
 * brand strings but would publish every server setting to every visitor. So
 * `vite.config.ts` defines `__APP_CONFIG__` as only the `app` and `client`
 * sections. The server half is not omitted by convention; it is not present.
 * `npm run verify:relay` asserts a built `dist/` contains none of it.
 *
 * The consequence: never `import` config.json from anything under `src/`.
 *
 * This file exists at all because the app has been renamed twice (FaChoy ->
 * Tabcore -> InBrowser) and each rename meant hunting the same handful of
 * strings across ~30 files by hand. What does NOT follow automatically, because
 * these files are read by tooling that expects to own them directly, and must
 * still be edited by hand on a rename:
 *
 *   - `package.json` (`name`, `description`, `homepage`, `repository.url`),
 *     and the generated `package-lock.json` / `bun.lock` copies of `name`
 *   - the actual GitHub repo name (an account-level action, not a file edit -
 *     `repoUrl` below tracks where it currently points, but renaming the repo
 *     itself still means editing config.json by hand)
 *   - `README.md`'s prose (reads oddly as pure template substitution)
 *   - persistence identifiers everywhere (`fachoy:*` localStorage keys, the
 *     `fachoy-*` IndexedDB/OPFS/Cache Storage names, the `<fachoy-artifact>`
 *     model protocol) - these are permanently frozen regardless of brand
 *     name; see the "Brand" section in CLAUDE.md for why
 *   - the brand mark itself, `src/components/Mark.tsx`, and its mirrored
 *     geometry in `scripts/generate-icons.mjs` - a name change doesn't imply
 *     a mark change
 */

import { deriveBrand, type BrandInput } from "./brandDerive";

/** The shape vite.config.ts hands us. Mirrors config.json's `app` + `client`. */
export interface PublicConfig {
  app: BrandInput;
  client: {
    relayUrl: string;
    searchBackend: string;
    streamIdleTimeoutMs: number;
    maxRoutingAttempts: number;
    suggestionsEnabled: boolean;
  };
}

const config: PublicConfig = __APP_CONFIG__;

/**
 * Every brand string below is derived by `deriveBrand`, which vite.config.ts
 * also calls to fill index.html's `__APP_*__` tokens. One function, so the
 * page head and the bundle cannot disagree about the title or the canonical
 * origin. See src/lib/brandDerive.ts for why it takes the config as an
 * argument instead of reading it.
 */
export const BRAND = deriveBrand(config.app);

export const APP_NAME = BRAND.name;
/** Lowercase, filesystem/URL-safe form - backup/export filenames, npm package name. */
export const APP_SLUG = BRAND.slug;
export const APP_DOMAIN = BRAND.domain;
export const APP_URL = BRAND.url;
export const APP_TAGLINE = BRAND.tagline;
export const APP_DESCRIPTION = BRAND.description;
/** `<title>` and social-card title: "{name} - {titleSuffix}". */
export const APP_TITLE = BRAND.title;
export const APP_TITLE_SUFFIX = BRAND.titleSuffix;
export const APP_OG_IMAGE_URL = BRAND.ogImage;
export const APP_REPO_URL = BRAND.repoUrl;
export const APP_ORG_NAME = BRAND.organizationName;
export const APP_LOGO_URL = BRAND.logoUrl;
export const APP_LOCALE = BRAND.locale;
/** Without the "@". Empty means: emit no twitter:site tag. */
export const APP_TWITTER_HANDLE = BRAND.twitterHandle;

/**
 * Default proxy relay base URL. Empty means this deployment's own origin, which
 * is correct when the server serves the client - see `gateway/proxy/relay.ts`.
 * A build hosted on a CDN with no server of its own must set an absolute URL in
 * config.json or the proxy feature has nowhere to go.
 */
export const APP_RELAY_URL = config.client.relayUrl;

/** Search backend a new user starts on; each user can change it in Settings. */
export const DEFAULT_SEARCH_BACKEND = config.client.searchBackend;

/**
 * How long a stream may go silent before it's treated as dead. Providers vary a
 * lot in time-to-first-token, so this is generous; it exists to catch a
 * connection that has gone away without closing, not to enforce a deadline.
 */
export const STREAM_IDLE_TIMEOUT_MS = config.client.streamIdleTimeoutMs;

/** How many candidates "auto" may try before giving up on a turn. */
export const MAX_ROUTING_ATTEMPTS = config.client.maxRoutingAttempts;

/**
 * Whether the chat empty state fetches its starter prompts from this
 * deployment's server. False removes the only first-party API call the client
 * makes on an ordinary page load, and the suggestion grid is simply not
 * rendered - the correct setting for a build hosted on a CDN with no server of
 * its own, which would otherwise request a 404 on every visit.
 *
 * Defaulted here rather than required, so a deployment carrying an older
 * config.json keeps working instead of rendering `undefined` as falsy and
 * silently losing the feature.
 */
export const SUGGESTIONS_ENABLED = config.client.suggestionsEnabled !== false;
