/**
 * Which proxy the paths without a retry loop should use.
 *
 * `chatStream` and `runCompletion` rotate across the pool as attempts fail, and
 * they own that logic themselves. Everything else - model discovery, media
 * generation, search, the page reader - makes one call with no failover, so it
 * just asks for the single best proxy.
 *
 * Deliberately no rotation here. Burning four proxies retrying a background
 * `listModels` would write four failures into the health store that chat depends
 * on for its own routing decisions, over a call the user can trivially retry.
 *
 * An empty or all-disabled pool returns null and the caller goes direct, which
 * is what keeps the default path unchanged for everyone who never configures a
 * proxy.
 */
import type { CustomProxy } from "../types";
import { getSettings } from "../gatewaySettings";
import { pickProxy } from "./proxyRouting";

const NONE_EXCLUDED: ReadonlySet<string> = new Set<string>();

export function getActiveProxy(): CustomProxy | null {
  const settings = getSettings();
  if (settings.mode !== "direct" || settings.proxies.length === 0) return null;
  return pickProxy(
    settings.proxies,
    NONE_EXCLUDED as Set<string>,
    settings.proxyRoutingMode,
    settings.manualProxyIds
  );
}

/** Convenience for the many call sites that want `proxy?: CustomProxy`. */
export function activeProxyOrUndefined(): CustomProxy | undefined {
  return getActiveProxy() ?? undefined;
}
