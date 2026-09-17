/**
 * Worker-scoped: gives a language engine's own internal asset-loading fetches
 * a chance to hit the Cache Storage bucket a plugin's install() populated
 * (see cacheStorageRuntimeInstall.ts) instead of always going to the network
 * - this is what makes "installed" actually mean something rather than
 * relying on implicit HTTP caching. Self-healing: a cache miss still falls
 * through to a normal fetch, and opportunistically caches that response too,
 * in case a file wasn't listed in the manifest.
 *
 * Extracted from pyodideWorker.ts, which was the only caller before this -
 * every worker backing a self-hosted, Cache-Storage-installed runtime
 * (Ruby, PHP, ...) calls this once at module scope with its own bucket name.
 */
export function installCacheFirstFetch(cacheName: string): void {
  const realFetch = self.fetch.bind(self);
  self.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === "GET") {
      try {
        const cache = await caches.open(cacheName);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await realFetch(request);
        if (response.ok) void cache.put(request, response.clone());
        return response;
      } catch {
        /* Cache Storage unavailable — fall through to a normal network fetch */
      }
    }
    return realFetch(request);
  };
}
