/**
 * The proxied half of `providerFetch`.
 *
 * A browser cannot speak HTTP CONNECT or SOCKS, so a real proxy needs something
 * server-side to dial it. This posts the request to the relay instead, which
 * opens a tunnel through a Cloudflare Worker (so the proxy sees Cloudflare's
 * address, never the relay's), wraps it in TLS to the provider, and streams the
 * reply back.
 *
 * The design goal here was that nothing downstream should be able to tell the
 * difference. The relay mirrors the provider's status and headers, so the
 * `Response` this returns is a genuine one from `fetch`, not a synthesized
 * object: `res.ok`, `res.status`, `res.json()`, `res.headers.get("retry-after")`
 * and a streaming `res.body` all behave natively, and `iterateSSEEvents()` works
 * unchanged. That is why there is no HTTP parser anywhere in the browser bundle.
 *
 * Everything descriptive travels in one base64url header rather than the URL,
 * because the payload carries the user's proxy credentials and query strings get
 * written to logs and history. One header also keeps the CORS preflight to
 * `content-type, x-relay-meta`.
 */
import type { CustomProxy } from "../../types";
import { GatewayError } from "../types";
import { relayFetchEndpoint } from "./relay";
import { getSettings } from "../../gatewaySettings";

interface RelayMeta {
  target: string;
  method: string;
  headers: Record<string, string>;
  proxy: {
    protocol: CustomProxy["protocol"];
    host: string;
    port: number;
    username?: string;
    password?: string;
    allowInsecureTls?: boolean;
  };
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Headers the relay sets itself. Passing them through would let a stale
 * Content-Length or a hop-by-hop header describe the wrong connection.
 */
const RESERVED = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "accept-encoding",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
]);

export async function relayFetch(
  targetUrl: string,
  init: RequestInit,
  proxy: CustomProxy,
  relayUrl: string,
  /** Settings tests supply the unsaved draft, including an explicit false. */
  allowInsecureProxyTls = getSettings().allowInsecureProxyTls
): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    if (!RESERVED.has(key.toLowerCase())) headers[key] = value;
  });

  const meta: RelayMeta = {
    target: targetUrl,
    method: (init.method ?? "GET").toUpperCase(),
    headers,
    proxy: {
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username || undefined,
      password: proxy.password || undefined,
      allowInsecureTls: proxy.allowInsecureTls === true || allowInsecureProxyTls === true || undefined,
    },
  };

  let response: Response;
  try {
    response = await fetch(relayFetchEndpoint(relayUrl), {
      method: "POST",
      // The body passes through untouched, so a FormData upload is never
      // buffered or re-encoded. Request bodies here are JSON or multipart and
      // modest; streaming one would need duplex:"half" and HTTP/2 for no gain.
      body: (init.body ?? null) as BodyInit | null,
      headers: { "X-Relay-Meta": toBase64Url(JSON.stringify(meta)) },
      signal: init.signal ?? null,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new GatewayError(
      0,
      `Could not reach the proxy relay. ${err instanceof Error ? err.message : ""}`.trim(),
      false, undefined, "relay_unreachable"
    );
  }

  // A deployment serving only the static bundle - a CDN, a fork - has no
  // /v1/fetch, and a static host answers an unknown path with the SPA shell
  // (a 200) rather than a 404. Without this the HTML is handed back as if it
  // were the provider's reply and surfaces as nonsense several layers later.
  //
  // A non-2xx status alongside an HTML body is a different thing entirely: a
  // deployment that DOES have a relay never returns HTML from its own code
  // (server/src/app.ts is JSON-only), so a 5xx HTML page here can only be
  // something in front of the origin - Cloudflare's own edge, or a reverse
  // proxy - answering because it couldn't reach it. That's a transient
  // outage, not "never configured", and telling a user whose relay is real
  // to go set one up in Settings is actively wrong advice.
  if ((response.headers.get("content-type") ?? "").includes("text/html")) {
    if (response.status >= 500) {
      throw new GatewayError(
        response.status,
        `The relay is temporarily unreachable (its host returned an HTML error page, HTTP ${response.status}) - this is usually a brief outage; retrying may help.`,
        false, undefined, "provider_gateway_error"
      );
    }
    throw new GatewayError(
      502,
      "This deployment has no proxy relay. Set a relay URL in Settings, or host the app with its server.",
      false, undefined, "relay_not_configured"
    );
  }

  // The relay reports its own failures as JSON, separately from anything the
  // provider said. Surfacing the relay's message and code is what carries a
  // proxy's real complaint ("the proxy rejected these credentials") all the
  // way to the user instead of a bare status code.
  if (!response.ok) {
    const relayError = await readRelayError(response);
    if (relayError) throw new GatewayError(response.status, relayError.error, false, undefined, relayError.code);
  }

  return response;
}

/**
 * Reads a relay-generated error body without consuming a provider response.
 * Only a JSON body carrying a string `error` is treated as the relay
 * speaking; anything else is the provider's own reply and is handed back
 * untouched.
 */
async function readRelayError(response: Response): Promise<{ error: string; code?: string } | null> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return null;
  try {
    const body = (await response.clone().json()) as { error?: unknown; code?: unknown };
    if (typeof body?.error !== "string") return null;
    return { error: body.error, code: typeof body.code === "string" ? body.code : undefined };
  } catch {
    return null;
  }
}
