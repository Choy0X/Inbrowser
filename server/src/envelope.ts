/**
 * Parsing the `X-Relay-Meta` header the browser sends.
 *
 * Everything descriptive about a proxied request - where it is going, how, and
 * through which proxy - travels in this one base64url header rather than in the
 * URL or in several headers. Two reasons. A single custom header keeps the CORS
 * preflight to `content-type, x-relay-meta`, and query strings are written to
 * request logs by Cloudflare, by browsers' history, and by anything in between,
 * while this payload carries the user's proxy credentials.
 *
 * The request body is not in here. It streams through untouched, so a multipart
 * upload never has to be buffered or re-encoded.
 */
import { PROXY_PROTOCOLS, type ProxyProtocol } from "./types.ts";

export interface RelayProxy {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Explicit per-request opt-in to skip provider certificate verification.
   *  The browser combines its individual proxy and all-proxies preferences. */
  allowInsecureTls?: boolean;
}

export interface RelayMeta {
  /** Absolute http(s) URL of the real destination. */
  target: string;
  method: string;
  /** Headers to send upstream, including the provider's own auth. */
  headers: Record<string, string>;
  proxy: RelayProxy;
}

export class EnvelopeError extends Error {}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** Headers the relay controls itself; a caller cannot override framing. */
const RESERVED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "accept-encoding",
  "te",
  "trailer",
]);

const MAX_META_BYTES = 8192;

export function parseRelayMeta(raw: string | undefined): RelayMeta {
  if (!raw) throw new EnvelopeError("Missing X-Relay-Meta header");
  if (raw.length > MAX_META_BYTES) throw new EnvelopeError("X-Relay-Meta is too large");

  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw new EnvelopeError("X-Relay-Meta is not valid base64url");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new EnvelopeError("X-Relay-Meta is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new EnvelopeError("X-Relay-Meta is not an object");

  const meta = parsed as Partial<RelayMeta>;

  let url: URL;
  try {
    url = new URL(String(meta.target));
  } catch {
    throw new EnvelopeError("X-Relay-Meta has no valid target URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EnvelopeError("Only http and https targets are supported");
  }

  const method = String(meta.method ?? "GET").toUpperCase();
  if (!METHODS.has(method)) throw new EnvelopeError(`Unsupported method ${method}`);

  const headers: Record<string, string> = {};
  if (meta.headers && typeof meta.headers === "object") {
    for (const [key, value] of Object.entries(meta.headers)) {
      if (typeof value !== "string") continue;
      if (RESERVED_HEADERS.has(key.toLowerCase())) continue;
      headers[key] = value;
    }
  }

  const proxy = meta.proxy;
  if (!proxy || typeof proxy !== "object") throw new EnvelopeError("X-Relay-Meta has no proxy");
  if (!PROXY_PROTOCOLS.includes(proxy.protocol as ProxyProtocol)) {
    throw new EnvelopeError("X-Relay-Meta has an unknown proxy protocol");
  }
  if (typeof proxy.host !== "string" || proxy.host.length === 0) {
    throw new EnvelopeError("X-Relay-Meta has no proxy host");
  }
  if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) {
    throw new EnvelopeError("X-Relay-Meta has an invalid proxy port");
  }

  return {
    target: url.toString(),
    method,
    headers,
    proxy: {
      protocol: proxy.protocol as ProxyProtocol,
      host: proxy.host,
      port: proxy.port,
      username: typeof proxy.username === "string" && proxy.username ? proxy.username : undefined,
      password: typeof proxy.password === "string" && proxy.password ? proxy.password : undefined,
      // Strict equality, never truthy-coerced: a malformed/forged header value
      // must collapse to false, not accidentally enable this.
      allowInsecureTls: proxy.allowInsecureTls === true,
    },
  };
}
