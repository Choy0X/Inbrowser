import type { CustomProxy, ProxyProtocol } from "../types";
import { parseProxyLine, parseProxyObject } from "./freeProxyList";

export type ProxyExportFormat = "urls" | "json";

export function inspectProxyList(text: string, fallback: ProxyProtocol) {
  const proxies: CustomProxy[] = [];
  const invalidRows: number[] = [];
  let rows: unknown[] | undefined;
  try {
    const value = JSON.parse(text);
    rows = Array.isArray(value) ? value : value?.proxies;
    if (!Array.isArray(rows)) throw new Error("Expected a JSON array or an object containing proxies.");
  } catch (error) {
    if (text.trim().startsWith("{") || /^\[\s*[{"\]]/.test(text.trim())) {
      throw new Error("Invalid proxy JSON. Use an array or an object containing proxies.");
    }
  }
  if (rows) {
    rows.forEach((row, i) => {
      const proxy = parseProxyObject(row, fallback, "Imported list");
      if (proxy) proxies.push(proxy); else invalidRows.push(i + 1);
    });
  } else {
    text.split(/\r\n|\r|\n/).forEach((line, i) => {
      if (!line.trim() || /^\s*(#|\/\/)/.test(line)) return;
      const proxy = parseProxyLine(line, fallback, "Imported list");
      if (proxy) proxies.push(proxy); else invalidRows.push(i + 1);
    });
  }
  return { proxies, invalidRows };
}

/** Explicit standalone export includes credentials. General backups remain secret-free. */
export function serializeProxyList(proxies: CustomProxy[], format: ProxyExportFormat): string {
  if (format === "json") return JSON.stringify(proxies, null, 2);
  return proxies.map(proxy => {
    const auth = proxy.username || proxy.password
      ? `${encodeURIComponent(proxy.username ?? "")}:${encodeURIComponent(proxy.password ?? "")}@` : "";
    const host = proxy.host.includes(":") && !proxy.host.startsWith("[") ? `[${proxy.host}]` : proxy.host;
    return `${proxy.protocol}://${auth}${host}:${proxy.port}`;
  }).join("\n") + "\n";
}
