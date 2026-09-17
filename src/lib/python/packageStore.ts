const PACKAGES_KEY = "fachoy:python-packages:v1";

/**
 * Python packages this app has downloaded, as recorded at install time.
 *
 * Synchronous by design, and for the same reason `installedModelIdsSync` in
 * plugins/executors.ts is: the catalogue holds ~356 rows, and answering
 * "is this installed?" by probing Cache Storage per row is exactly the fan-out
 * that once fired 163 concurrent probes on mount.
 *
 * The record is the fast, authoritative answer for anything installed through
 * the Store. It is deliberately *not* the whole truth: running code that
 * imports a package downloads its wheel into the same Cache Storage bucket
 * without passing through here, so a package can be cached and offline-ready
 * while unlisted. That only ever understates what works, never overstates it.
 */
export function installedPackagesSync(): Set<string> {
  try {
    const raw = localStorage.getItem(PACKAGES_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function save(names: Set<string>): void {
  try {
    localStorage.setItem(PACKAGES_KEY, JSON.stringify([...names]));
  } catch {
    /* ignore */
  }
}

export function recordPackageInstalled(name: string): void {
  const names = installedPackagesSync();
  names.add(name);
  save(names);
}

export function recordPackageUninstalled(name: string): void {
  const names = installedPackagesSync();
  names.delete(name);
  save(names);
}

/** Clears the record wholesale - used when the Python runtime itself is removed,
 *  since uninstalling it deletes the Cache Storage bucket the wheels live in. */
export function clearInstalledPackages(): void {
  save(new Set());
}
