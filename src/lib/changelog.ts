export interface ChangelogEntry {
  version: string;
  date: string;
  items: string[];
}

/**
 * Fetched as a plain static asset rather than imported as a bundled module,
 * so a version the running JS hasn't loaded yet can still be read - e.g. to
 * show what a pending service-worker update actually contains before it's
 * applied.
 */
export async function fetchChangelog(fresh = false): Promise<ChangelogEntry[]> {
  const url = fresh ? `/changelog.json?t=${Date.now()}` : "/changelog.json";
  const res = await fetch(url, { cache: fresh ? "no-store" : "default" });
  if (!res.ok) return [];
  return (await res.json()) as ChangelogEntry[];
}

/** Entries strictly newer than `currentVersion` (list is newest-first). */
export function pendingEntries(all: ChangelogEntry[], currentVersion: string): ChangelogEntry[] {
  const idx = all.findIndex((e) => e.version === currentVersion);
  if (idx === -1) return all.slice(0, 1);
  return all.slice(0, idx);
}

/** Entries at or before `currentVersion` - what's actually installed and safe to show. */
export function installedEntries(all: ChangelogEntry[], currentVersion: string): ChangelogEntry[] {
  const idx = all.findIndex((e) => e.version === currentVersion);
  if (idx === -1) return all.slice(1);
  return all.slice(idx);
}
