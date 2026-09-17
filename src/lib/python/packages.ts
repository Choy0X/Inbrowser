import { version as PYODIDE_VERSION } from "pyodide";

/**
 * The Pyodide package index.
 *
 * `vite.config.ts` self-hosts exactly four Pyodide files, and no `.whl` among
 * them - see its PYODIDE_RUNTIME_FILES comment. But one of those four is
 * `pyodide-lock.json`, which indexes every package this build can install
 * (~356 of them), so Pyodide knows pandas exists and confidently resolves it
 * against `indexURL` - where it 404s.
 *
 * The wheels themselves come from jsDelivr's Pyodide CDN, pinned to this exact
 * build. That is a deliberate, narrow exception to "self-hosted, never a CDN",
 * already taken once in pyodideWorker.ts for `requests`, and it is a safer one
 * than it looks: Pyodide passes each wheel's `sha256` *from the self-hosted
 * lock file* as an SRI `integrity` hash, so the CDN is trusted for bytes but
 * never for their integrity. A wheel that came back wrong is rejected by the
 * browser, not by us.
 *
 * Everything else stays self-hosted, and a wheel is only fetched for an import
 * the user's own code asked for.
 */
export const PYODIDE_PACKAGE_BASE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/** Self-hosted, and already installed into Cache Storage by pythonPlugin. */
const LOCK_URL = "/pyodide/pyodide-lock.json";

export interface PyodidePackage {
  /** The lock file's own spelling, e.g. "python-dateutil". */
  name: string;
  version: string;
  /** Wheel filename, relative to PYODIDE_PACKAGE_BASE_URL. */
  fileName: string;
  /** Direct dependencies, in the lock file's spelling. */
  depends: string[];
  /** Module names this package provides - what an `import` line actually says. */
  imports: string[];
  /** "package" for real libraries; the lock also carries "cpython_module" etc. */
  packageType: string;
}

interface LockEntry {
  name?: string;
  version?: string;
  file_name?: string;
  depends?: string[];
  imports?: string[];
  package_type?: string;
}

/**
 * Package names are compared case-insensitively with `_` and `-` treated as the
 * same character, which is how Python itself normalises a distribution name -
 * the lock holds "python-dateutil" while the wheel is "python_dateutil-2.9...".
 */
export function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/_/g, "-");
}

let packagesPromise: Promise<PyodidePackage[]> | null = null;

/**
 * Reads the self-hosted lock once per session. Memoized on the promise rather
 * than the result so concurrent callers (the Store opening while a run is
 * resolving imports) share one fetch.
 */
export function loadPyodidePackages(): Promise<PyodidePackage[]> {
  if (!packagesPromise) {
    packagesPromise = (async () => {
      const response = await fetch(LOCK_URL);
      if (!response.ok) throw new Error(`Could not read the Python package index (${response.status}).`);
      const lock = (await response.json()) as { packages?: Record<string, LockEntry> };
      return Object.entries(lock.packages ?? {}).map(([key, entry]) => ({
        name: entry.name ?? key,
        version: entry.version ?? "",
        fileName: entry.file_name ?? "",
        depends: entry.depends ?? [],
        imports: entry.imports ?? [],
        packageType: entry.package_type ?? "package",
      }));
    })().catch((err) => {
      // Don't cache a failure: a transient miss would otherwise leave the Store
      // permanently empty for the rest of the session.
      packagesPromise = null;
      throw err;
    });
  }
  return packagesPromise;
}

/** Lookup keyed by normalized name, built once per package list. */
function indexByName(packages: PyodidePackage[]): Map<string, PyodidePackage> {
  const index = new Map<string, PyodidePackage>();
  for (const pkg of packages) index.set(normalizePackageName(pkg.name), pkg);
  return index;
}

/**
 * Every package needed to install `names`, including the roots.
 *
 * Ported from the `_closure` helper that pyodideWorker.ts's NETWORK_PATCH_PY
 * ran in Python to install `requests`; that copy becomes unnecessary once
 * `packageBaseUrl` is set, but the Store still needs the same walk to know what
 * an install will actually download. Iterative and `seen`-guarded, because the
 * real lock contains cycles.
 *
 * Unknown names are skipped rather than throwing: a dependency the lock does
 * not carry is one Pyodide will not try to fetch either.
 */
export function resolveClosure(names: string[], packages: PyodidePackage[]): PyodidePackage[] {
  const index = indexByName(packages);
  const seen = new Set<string>();
  const out: PyodidePackage[] = [];
  const stack = [...names];

  while (stack.length > 0) {
    const key = normalizePackageName(stack.pop()!);
    if (seen.has(key)) continue;
    const pkg = index.get(key);
    if (!pkg) continue;
    seen.add(key);
    out.push(pkg);
    stack.push(...pkg.depends);
  }

  return out;
}

/** Absolute, version-pinned CDN URL for a package's wheel. */
export function wheelUrl(pkg: PyodidePackage): string {
  return `${PYODIDE_PACKAGE_BASE_URL}${pkg.fileName}`;
}

/**
 * The rows worth showing in the Store: real libraries only. The lock also
 * indexes CPython's own shared modules, which are already inside
 * python_stdlib.zip and cannot be meaningfully installed or removed.
 */
export function installablePackages(packages: PyodidePackage[]): PyodidePackage[] {
  return packages
    .filter((pkg) => pkg.packageType === "package" && pkg.fileName)
    .sort((a, b) => a.name.localeCompare(b.name));
}
