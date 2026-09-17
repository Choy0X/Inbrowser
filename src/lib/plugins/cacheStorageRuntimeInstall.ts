import type { InstallProgress } from "./types";

/**
 * Shared "download a language engine's self-hosted assets into Cache
 * Storage, with progress" logic - pythonPlugin.ts's install() before this
 * was extracted, generalized so each new large runtime (Ruby, PHP, ...)
 * doesn't reimplement the same fetch/cache/progress loop.
 */

interface RuntimeManifest {
  files: string[];
}

async function fetchManifest(manifestUrl: string): Promise<RuntimeManifest> {
  const res = await fetch(manifestUrl);
  if (!res.ok) throw new Error(`Could not load runtime manifest (${res.status})`);
  return res.json();
}

export async function installCachedRuntimeAssets({
  cacheName,
  baseUrl,
  manifestUrl,
  onProgress,
  signal,
}: {
  /** Cache Storage bucket name, e.g. "fachoy-plugin-ruby". */
  cacheName: string;
  /** Directory the manifest's file names are relative to, e.g. "/ruby/". */
  baseUrl: string;
  /** Where to fetch the manifest itself, e.g. "/ruby/ruby-manifest.json". */
  manifestUrl: string;
  onProgress: (p: InstallProgress) => void;
  signal: AbortSignal;
}): Promise<void> {
  const manifest = await fetchManifest(manifestUrl);
  const cache = await caches.open(cacheName);
  let loaded = 0;
  const total = manifest.files.length;
  onProgress({ loaded, total });

  for (const file of manifest.files) {
    if (signal.aborted) throw new DOMException("Install cancelled", "AbortError");
    const url = `${baseUrl}${file}`;
    // Reported before the fetch, not after: on a runtime whose largest asset is
    // tens of megabytes, the interesting moment is the one being waited on.
    onProgress({ loaded, total, file });
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Failed to download ${file} (${res.status})`);
    await cache.put(url, res.clone());
    loaded += 1;
    onProgress({ loaded, total, file });
  }
}
