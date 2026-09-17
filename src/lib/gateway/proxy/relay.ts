/**
 * Resolving which relay to use, and checking that it is alive.
 *
 * The relay is only ever reached when the user has configured a proxy. With an
 * empty proxy pool nothing in this directory is imported at all - `providerFetch`
 * reaches it through a dynamic `import()`, so the default path stays exactly
 * what it has always been: browser straight to provider, no hop.
 */
import { APP_RELAY_URL } from "../../appConfig";
import { getSettings } from "../../gatewaySettings";

export interface RelayHealth {
  ok: boolean;
  version?: string;
  error?: string;
}

/** Trailing slashes make `${base}/v1/fetch` produce a double slash on some hosts. */
function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * The user's own relay if they set one, otherwise the app default. An empty
 * override deliberately falls through rather than being stored as the default,
 * so changing `client.relayUrl` in config.json reaches every user who never
 * overrode it.
 */
export function getRelayUrl(override?: string): string {
  const explicit = override !== undefined ? override : getSettings().relayUrl;
  const chosen = explicit && explicit.trim() ? explicit : APP_RELAY_URL;
  return normalize(chosen);
}

export function relayFetchEndpoint(relayUrl: string): string {
  return `${normalize(relayUrl)}/v1/fetch`;
}

/** Used by the Test relay button in Settings. */
export async function testRelay(relayUrl: string, signal?: AbortSignal): Promise<RelayHealth> {
  const base = normalize(relayUrl || APP_RELAY_URL);
  try {
    const res = await fetch(`${base}/health`, { method: "GET", signal });
    if (!res.ok) return { ok: false, error: `The relay answered ${res.status}.` };
    const body = (await res.json()) as { ok?: boolean; version?: string };
    if (!body?.ok) return { ok: false, error: "The relay answered, but not as a relay." };
    return { ok: true, version: body.version };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the relay." };
  }
}
