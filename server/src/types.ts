/**
 * The proxy protocol union, duplicated from the app's `src/lib/types.ts`.
 *
 * The VPS relay is a separate deployable with its own tsconfig and its own
 * (empty) dependency tree - it does not import from the app's source, so this
 * small union is restated rather than shared. `npm run verify:relay` asserts the
 * two lists agree, which is the only coupling that actually matters.
 */
export type ProxyProtocol = "http" | "https" | "socks5" | "socks4";

export const PROXY_PROTOCOLS: readonly ProxyProtocol[] = ["http", "https", "socks5", "socks4"];
