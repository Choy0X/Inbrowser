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
    // `new Request(input, init)` carries `integrity` through, so Pyodide's SRI
    // check on a package wheel still applies on the network path below. A cache
    // hit skips it, which is correct: the entry was only written after a
    // response that had already passed it.
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method !== "GET") return realFetch(request);

    // Scoped to the Cache Storage calls *only*. This used to wrap the network
    // fetch too, so a failed request fell into the catch and was retried by the
    // call below - every failure cost two round trips, and the error the caller
    // finally saw came from the second attempt rather than the real one.
    let cache: Cache | undefined;
    try {
      cache = await caches.open(cacheName);
      const cached = await cache.match(request);
      if (cached) return cached;
    } catch {
      /* Cache Storage unavailable — fall through to a normal network fetch */
    }

    const response = await realFetch(request);
    if (cache && response.ok) {
      try {
        void cache.put(request, response.clone());
      } catch {
        /* Quota exceeded or an opaque response — serving it still works */
      }
    }
    return response;
  };
}
