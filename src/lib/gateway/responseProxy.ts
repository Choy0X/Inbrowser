import type { CustomProxy, ResponseProxy } from "../types";

export function responseProxy(proxy?: CustomProxy | null): ResponseProxy | null {
  if (!proxy) return null;
  const { id, label, protocol, host, port } = proxy;
  return { id, label, protocol, host, port };
}

export function responseProxyLabel(proxy: ResponseProxy): string {
  const host = proxy.host.includes(":") ? `[${proxy.host}]` : proxy.host;
  const endpoint = `${proxy.protocol}://${host}:${proxy.port}`;
  return proxy.label ? `${proxy.label} (${endpoint})` : endpoint;
}
