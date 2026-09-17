/**
 * Public proxy lists the finder pulls from.
 *
 * ADMISSION RULE, and it is stricter than the list this replaced. Every entry
 * below was opened, confirmed to return 200, confirmed to send
 * `Access-Control-Allow-Origin: *`, and confirmed to parse, before being added.
 * Do not add a URL from memory or by guessing a repo layout.
 *
 * The rule is stricter now because the consequence changed. The old
 * `freeProxyCandidates.ts` listed CORS-forwarding services and a dead entry
 * there was genuinely harmless - the live check marked it dead and that was the
 * end of it. Here a wrong URL means the finder silently yields nothing from that
 * source and the user sees a shorter list with no explanation, so an unverified
 * entry is a bug rather than a no-op.
 *
 * Why these hosts are reachable from a static page at all: jsDelivr serves
 * `cdn.jsdelivr.net/gh` with `ACAO: *`, which `lib/skillMarketplace.ts` already
 * documents and depends on. No relay is involved in fetching the lists - only in
 * testing the proxies they contain.
 *
 * Worth knowing before trusting any of this: the overwhelming majority of
 * public proxies are dead, slow, or actively hostile at any given moment. The
 * finder exists to make them easy to try, not to suggest they are good. The
 * design is at least robust to a hostile exit - it sees only TLS ciphertext -
 * but a proxy you control will be faster and far more reliable.
 */
import type { ProxyProtocol } from "../types";

export interface FreeProxySource {
  /** Stable slug - the React key and the `source` stamped onto imported proxies. */
  id: string;
  label: string;
  url: string;
  /**
   * Protocol to assume for entries that carry no scheme of their own. Entries
   * written as `socks5://host:port` override this.
   */
  protocol: ProxyProtocol;
  /** Short, specific note shown in the finder. Omit rather than pad. */
  notes?: string;
}

export const FREE_PROXY_SOURCES: FreeProxySource[] = [
  {
    id: "proxifly-http",
    label: "Proxifly - HTTP",
    url: "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt",
    protocol: "http",
    notes: "refreshed every 5 minutes; entries carry an explicit scheme",
  },
  {
    id: "proxifly-socks4",
    label: "Proxifly - SOCKS4",
    url: "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks4/data.txt",
    protocol: "socks4",
  },
  {
    id: "proxifly-socks5",
    label: "Proxifly - SOCKS5",
    url: "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt",
    protocol: "socks5",
  },
  {
    id: "speedx-http",
    label: "TheSpeedX - HTTP",
    url: "https://cdn.jsdelivr.net/gh/TheSpeedX/PROXY-List@master/http.txt",
    protocol: "http",
    notes: "bare host:port, no scheme - protocol comes from the file it is in",
  },
  {
    id: "speedx-socks4",
    label: "TheSpeedX - SOCKS4",
    url: "https://cdn.jsdelivr.net/gh/TheSpeedX/PROXY-List@master/socks4.txt",
    protocol: "socks4",
  },
  {
    id: "speedx-socks5",
    label: "TheSpeedX - SOCKS5",
    url: "https://cdn.jsdelivr.net/gh/TheSpeedX/PROXY-List@master/socks5.txt",
    protocol: "socks5",
  },
  {
    id: "monosans-http",
    label: "monosans - HTTP",
    url: "https://cdn.jsdelivr.net/gh/monosans/proxy-list@main/proxies/http.txt",
    protocol: "http",
    notes: "smaller list, checked more aggressively upstream",
  },
  {
    id: "monosans-socks4",
    label: "monosans - SOCKS4",
    url: "https://cdn.jsdelivr.net/gh/monosans/proxy-list@main/proxies/socks4.txt",
    protocol: "socks4",
  },
  {
    id: "monosans-socks5",
    label: "monosans - SOCKS5",
    url: "https://cdn.jsdelivr.net/gh/monosans/proxy-list@main/proxies/socks5.txt",
    protocol: "socks5",
  },
];
