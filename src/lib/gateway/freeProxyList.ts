/**
 * Parsing public proxy lists into CustomProxy entries.
 *
 * Pure - no fetch, no DOM - so `npm run verify:relay` can exercise every format
 * against fixtures without touching the network.
 *
 * Four line formats occur in the wild across the sources in freeProxySources.ts:
 *
 *   host:port                     bare, protocol comes from the source file
 *   scheme://host:port            explicit, overrides the source's protocol
 *   host:port:username:password   credentialed, used by paid-list exports
 *   scheme://user:pass@host:port  URL form with inline credentials
 *
 * A JSON array of `{ip, port, protocol}` objects also appears (Proxifly ships
 * one alongside its text lists), so that is handled too.
 */
import type { CustomProxy, ProxyProtocol } from "../types";
import { PROXY_PROTOCOLS } from "../types";
import { newId } from "../store";

/** Cap on how many entries one scan will consider, across all sources. */
export const MAX_PARSED_PROXIES = 2000;

const SCHEME_ALIASES: Record<string, ProxyProtocol> = {
  http: "http",
  https: "https",
  socks: "socks5",
  socks5: "socks5",
  socks5h: "socks5",
  socks4: "socks4",
  socks4a: "socks4",
};

function isPlausibleHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  return /^[a-zA-Z0-9._-]+$/.test(host) || /^\[[0-9a-fA-F:.]+\]$/.test(host) || (host.includes(":") && /^[0-9a-fA-F:.]+$/.test(host));
}

function makeProxy(
  protocol: ProxyProtocol,
  host: string,
  port: number,
  source: string,
  username?: string,
  password?: string
): CustomProxy | null {
  if (!isPlausibleHost(host)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    id: newId(),
    label: `${host}:${port}`,
    protocol,
    host,
    port,
    // SOCKS4 has no password field on the wire; carrying one here would only
    // surface later as a confusing validation error.
    username: username || undefined,
    password: protocol === "socks4" ? undefined : password || undefined,
    enabled: true,
    source,
  };
}

/** Parses one line without allowing malformed credentials to abort a list. */
export function parseProxyLine(line: string, fallback: ProxyProtocol, source: string): CustomProxy | null {
  const text = line.trim();
  if (!text || text.startsWith("#") || text.startsWith("//")) return null;
  const scheme = /^([a-zA-Z0-9]+):\/\/(.*)$/.exec(text);
  const protocol = scheme ? SCHEME_ALIASES[scheme[1].toLowerCase()] : fallback;
  if (!protocol) return null;
  let rest = scheme ? scheme[2] : text;
  let username: string | undefined;
  let password: string | undefined;
  const hostFirst = /^(\[[0-9a-fA-F:.]+\]|[^:@\s]+):(\d+):([^:]*):(.*)$/.exec(rest);
  if (hostFirst && (!scheme || !rest.includes("@"))) return makeProxy(protocol, hostFirst[1], Number(hostFirst[2]), source, hostFirst[3], hostFirst[4]);
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    const auth = rest.slice(0, at);
    const colon = auth.indexOf(":");
    try {
      username = decodeURIComponent(colon < 0 ? auth : auth.slice(0, colon));
      password = colon < 0 ? undefined : decodeURIComponent(auth.slice(colon + 1));
    } catch { return null; }
    rest = rest.slice(at + 1);
  }
  const endpoint = /^(\[[0-9a-fA-F:.]+\]|[^:\s/?#]+):(\d+)\/?$/.exec(rest);
  return endpoint ? makeProxy(protocol, endpoint[1], Number(endpoint[2]), source, username, password) : null;
}

export function parseProxyObject(value: unknown, fallback: ProxyProtocol, source: string): CustomProxy | null {
  if (typeof value === "string") return parseProxyLine(value, fallback, source);
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const rawProtocol = row.protocol ?? row.type;
  const protocol = rawProtocol === undefined ? fallback : typeof rawProtocol === "string" ? SCHEME_ALIASES[rawProtocol.toLowerCase()] : undefined;
  if (!protocol) return null;
  const host = row.host ?? row.ip ?? row.address;
  const username = row.username ?? row.user;
  const password = row.password ?? row.pass;
  if (typeof host !== "string" || (username !== undefined && typeof username !== "string") || (password !== undefined && typeof password !== "string")) return null;
  const proxy = makeProxy(protocol, host.trim(), Number(row.port), source, username as string | undefined, password as string | undefined);
  if (!proxy) return null;
  if (typeof row.label === "string" && row.label.trim()) proxy.label = row.label;
  if (typeof row.enabled === "boolean") proxy.enabled = row.enabled;
  // Imported files never silently opt a proxy into unverified TLS.
  return proxy;
}

/** Public sources skip malformed entries; Settings reports them separately. */
export function parseProxyList(body: string, fallback: ProxyProtocol, source: string): CustomProxy[] {
  const trimmed = body.trim();
  try {
    const value = JSON.parse(trimmed);
    const rows = Array.isArray(value) ? value : value?.proxies;
    if (Array.isArray(rows)) return rows.flatMap(row => {
      const proxy = parseProxyObject(row, fallback, source);
      return proxy ? [proxy] : [];
    });
  } catch { /* Bracketed IPv6 can be plain text. */ }
  return trimmed.split(/\r\n|\r|\n/).flatMap(line => {
    const proxy = parseProxyLine(line, fallback, source);
    return proxy ? [proxy] : [];
  });
}

/** Accounts on the same gateway are distinct. Never display this key. */
export function proxyKey(proxy: Pick<CustomProxy, "protocol" | "host" | "port" | "username" | "password">): string {
  const endpoint = proxy.protocol + "://" + proxy.host.toLowerCase() + ":" + proxy.port;
  return proxy.username || proxy.password ? endpoint + JSON.stringify([proxy.username ?? "", proxy.password ?? ""]) : endpoint;
}

/**
 * Merges parsed lists, dropping duplicates and anything already in the pool,
 * and caps the total. Shuffles deterministically-ish by interleaving sources so
 * a capped scan is not entirely drawn from whichever list happened to be first
 * and largest.
 */
export function mergeProxyLists(lists: CustomProxy[][], existing: CustomProxy[] = []): CustomProxy[] {
  const seen = new Set(existing.map(proxyKey));
  const out: CustomProxy[] = [];
  const cursors = lists.map(() => 0);

  for (;;) {
    let advanced = false;
    for (let i = 0; i < lists.length; i++) {
      const list = lists[i];
      while (cursors[i] < list.length) {
        const candidate = list[cursors[i]++];
        const key = proxyKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(candidate);
        advanced = true;
        break;
      }
      if (out.length >= MAX_PARSED_PROXIES) return out;
    }
    if (!advanced) break;
  }
  return out;
}

export function isKnownProtocol(value: string): value is ProxyProtocol {
  return (PROXY_PROTOCOLS as readonly string[]).includes(value);
}
