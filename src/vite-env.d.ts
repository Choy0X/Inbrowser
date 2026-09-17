/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __APP_VERSION__: string;

/**
 * config.json's `app` and `client` sections, injected by vite.config.ts.
 *
 * Deliberately NOT the whole file: the `server` section holds the relay secret,
 * and a plain JSON import would inline all of it into the bundle. See the header
 * of src/lib/appConfig.ts.
 */
declare const __APP_CONFIG__: import("./lib/appConfig").PublicConfig;
