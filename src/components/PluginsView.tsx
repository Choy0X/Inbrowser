import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CircleAlert, Cpu, ExternalLink, HardDrive, Puzzle, Search, Trash2 } from "lucide-react";
import { buildCatalog, BUNDLED_CATALOG } from "../lib/plugins/catalog";
import {
  requirementLabel,
  unmetRequirement,
  type InstallProgress,
  type PluginCategory,
  type PluginManifest,
  type PluginRequirement,
} from "../lib/plugins/manifest";
import { installPlugin, knownInstalledIds, uninstallPlugin } from "../lib/plugins/executors";
import { getPluginState, loadPluginStates, savePluginStates, type PluginStateMap } from "../lib/pluginStore";
import { useDebounced } from "../lib/useDebounced";
import { PageShell } from "./PageShell";
import { Toggle } from "./Toggle";
import { Tooltip } from "./Tooltip";
import { Badge, Button, Disclosure, EmptyState, IconButton, Progress, SearchInput } from "./ui";
import { localErrorMessage } from "../lib/gateway/local/errors";

/**
 * The installable catalogue.
 *
 * ~165 entries (runtimes, tools and every local model), so the list is
 * virtualized and install state comes from a synchronous record rather than a
 * probe. The first version asked `isPluginInstalled` for every entry on mount,
 * and each local-model answer loaded the 6 MB WebLLM module before probing
 * Cache Storage - 160+ concurrent probes before a single row could render.
 */

const ROW_ESTIMATE = 116;

/**
 * The Store's tab ids that still use the installable-catalogue view, mapped
 * onto the manifest categories. Packages has its own view (`PackageCatalog`) -
 * it's not installable, so it doesn't belong to this map.
 */
export type CatalogCategory = "runtimes" | "tools" | "models";
const CATEGORY_OF: Record<CatalogCategory, PluginCategory> = {
  runtimes: "runtime",
  tools: "tool",
  models: "model",
};

function formatSize(mb: number): string {
  if (mb === 0) return "built in";
  if (mb < 1000) return `~${mb} MB`;
  return `~${(mb / 1024).toFixed(1)} GB`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * One catalogue row. Memoized because an install streams progress many times a
 * second, and without this every visible row re-rendered on each tick. Every
 * prop is reference-stable: the callbacks take the manifest as an argument
 * rather than closing over it.
 */
const PluginRow = memo(function PluginRow({
  manifest,
  installed,
  phase,
  error,
  unmet,
  enabled,
  onInstall,
  onUninstall,
  onCancel,
  onToggle,
}: {
  manifest: PluginManifest;
  installed: boolean;
  phase: InstallProgress | "starting" | undefined;
  error: string | undefined;
  unmet: PluginRequirement | null;
  enabled: boolean;
  onInstall: (m: PluginManifest) => void;
  onUninstall: (m: PluginManifest) => void;
  onCancel: (m: PluginManifest) => void;
  onToggle: (m: PluginManifest, enabled: boolean) => void;
}) {
  const busy = phase !== undefined;
  const isBuiltin = manifest.builtin === true;

  return (
    <div className="rounded-2xl border border-border bg-bg-elevated p-3.5 shadow-soft">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {manifest.category === "model" && <Cpu size={13} className="shrink-0 text-accent" />}
            <span className="min-w-0 break-words text-sm font-medium">{manifest.name}</span>
            <Badge>{formatSize(manifest.estimatedSizeMB)}</Badge>
            {manifest.category === "model" && <Badge tone="info">Offline</Badge>}
            {manifest.category === "tool" && <Badge tone="accent">Tool</Badge>}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-fg-dim">{manifest.description}</p>

          {unmet && (
            <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-4 text-warning">
              <CircleAlert size={11} className="mt-0.5 shrink-0" /> {requirementLabel(unmet)}
            </p>
          )}

          {busy && (
            <Progress
              className="mt-2 max-w-xs"
              value={typeof phase === "object" && phase.total > 0 ? phase.loaded / phase.total : undefined}
              label={typeof phase === "object" ? phase.text ?? `${phase.loaded} / ${phase.total}` : "Starting..."}
            />
          )}

          {error && (
            <p className="mt-1.5 flex items-start gap-1 text-xs text-error">
              <CircleAlert size={12} className="mt-0.5 shrink-0" /> {error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 self-start sm:self-auto">
          {isBuiltin ? (
            <>
              <Toggle checked={true} onChange={() => {}} disabled />
              <IconButton
                label={`${manifest.name} can't be removed`}
                icon={<Trash2 size={15} />}
                onClick={() => {}}
                disabled
              />
            </>
          ) : installed ? (
            <>
              {/* A model has no on/off state: a downloaded weight set is either
               *  there for use or it isn't. */}
              {manifest.category !== "model" && (
                <Toggle checked={enabled} onChange={(next) => onToggle(manifest, next)} />
              )}
              <IconButton
                label={`Uninstall ${manifest.name}`}
                icon={<Trash2 size={15} />}
                onClick={() => onUninstall(manifest)}
                className="hover:text-error"
              />
            </>
          ) : busy ? (
            <Button size="sm" loading onClick={() => onCancel(manifest)}>
              Cancel
            </Button>
          ) : unmet ? (
            // A disabled <button> doesn't fire the mouse events Tooltip listens
            // for, so it's wrapped in a plain span the tooltip can attach to.
            <Tooltip label={requirementLabel(unmet)}>
              <span className="inline-flex">
                <Button variant="primary" disabled>
                  Install
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Button variant="primary" onClick={() => onInstall(manifest)}>
              Install
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});

const RUNTIME_LABELS: Record<string, string> = {
  python: "Python",
};

function runtimeLabel(runtime: string): string {
  return RUNTIME_LABELS[runtime] ?? runtime.charAt(0).toUpperCase() + runtime.slice(1);
}

/**
 * One package row: purely informational, no install affordance. A package
 * installs itself the first time code imports it (Pyodide's own
 * `loadPackagesFromImports`), so there is nothing here for the user to trigger -
 * only what the package is, what it depends on, and what it makes importable.
 */
const PackageRow = memo(function PackageRow({ manifest }: { manifest: PluginManifest }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-elevated p-3.5 shadow-soft">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 break-words text-sm font-medium">{manifest.name}</span>
        <Badge>v{manifest.version}</Badge>
        {manifest.runtime && <Badge tone="accent">{runtimeLabel(manifest.runtime)}</Badge>}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-fg-dim">{manifest.description}</p>
      <Disclosure summary="More info" className="mt-2">
        <div className="space-y-1.5 px-3 py-2.5 text-xs leading-relaxed text-fg-dim">
          <p>
            <span className="font-medium text-fg">Provides:</span>{" "}
            {manifest.provides && manifest.provides.length > 0
              ? manifest.provides.join(", ")
              : "no importable modules of its own"}
          </p>
          <p>
            <span className="font-medium text-fg">Depends on:</span>{" "}
            {manifest.dependsOn && manifest.dependsOn.length > 0 ? manifest.dependsOn.join(", ") : "nothing else"}
          </p>
          {manifest.homepage && (
            <a
              href={manifest.homepage}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-accent hover:underline"
            >
              <ExternalLink size={11} /> View on PyPI
            </a>
          )}
        </div>
      </Disclosure>
    </div>
  );
});

type PackageListRow =
  | { kind: "header"; id: string; label: string; count: number }
  | { kind: "row"; id: string; manifest: PluginManifest };

/**
 * The Packages tab: a view-only catalogue grouped by runtime. Only Python has
 * an installable package index today (the other runtimes are engine-only, with
 * no package manager of their own), but grouping by `manifest.runtime` up front
 * means a future runtime's packages slot into the same list rather than needing
 * a rewrite.
 *
 * Deliberately a separate component from `PluginCatalog` rather than a branch
 * inside it: switching tabs re-renders the same `PluginCatalog` instance with a
 * new `category` prop, and an early return before that component's hooks would
 * change how many hooks run between renders of one instance, which React
 * forbids. Two components at the call site remount cleanly instead.
 */
export function PackageCatalog() {
  const [catalog, setCatalog] = useState<PluginManifest[]>(BUNDLED_CATALOG);
  const [query, setQuery] = useState("");
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const debouncedQuery = useDebounced(query, 120);

  useEffect(() => {
    let cancelled = false;
    void buildCatalog().then((full) => {
      if (!cancelled) setCatalog(full);
    });
    void navigator.storage?.estimate?.().then((e) => setStorage({ usage: e.usage ?? 0, quota: e.quota ?? 0 }));
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = debouncedQuery.trim().toLowerCase();
    return catalog.filter((m) => {
      if (m.category !== "package") return false;
      if (!needle) return true;
      return (
        m.name.toLowerCase().includes(needle) ||
        m.description.toLowerCase().includes(needle) ||
        m.tags.some((t) => t.includes(needle))
      );
    });
  }, [catalog, debouncedQuery]);

  // Grouped by runtime, then flattened into one row list so the whole thing
  // stays a single virtualizer - two independent virtualizers sharing one
  // scroll container can't agree on which items are actually visible.
  const rows = useMemo(() => {
    const groups = new Map<string, PluginManifest[]>();
    for (const m of filtered) {
      const key = m.runtime ?? "other";
      const group = groups.get(key);
      if (group) group.push(m);
      else groups.set(key, [m]);
    }
    const sortedKeys = [...groups.keys()].sort((a, b) => runtimeLabel(a).localeCompare(runtimeLabel(b)));
    const flat: PackageListRow[] = [];
    for (const key of sortedKeys) {
      const items = groups.get(key) ?? [];
      flat.push({ kind: "header", id: `header:${key}`, label: runtimeLabel(key), count: items.length });
      for (const manifest of items) flat.push({ kind: "row", id: manifest.id, manifest });
    }
    return flat;
  }, [filtered]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.kind === "header" ? 32 : ROW_ESTIMATE),
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 6,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rows, virtualizer]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SearchInput
        icon={<Search size={13} />}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Search ${filtered.length} packages...`}
      />
      <p className="mt-2 text-[11px] text-fg-faint">
        Packages install automatically the first time your code imports them - there's nothing to install here.
      </p>

      {storage && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-fg-faint">
          <HardDrive size={12} className="shrink-0" />
          {formatBytes(storage.usage)} used
          {storage.quota > 0 && ` of about ${formatBytes(storage.quota)} available to this site`}
        </p>
      )}

      <div ref={scrollRef} className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
        {rows.length === 0 ? (
          <EmptyState icon={<Puzzle size={20} />} title="Nothing matches that." />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((row) => {
              const item = rows[row.index];
              return (
                <div
                  key={item.id}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${row.start}px)`,
                  }}
                  className={item.kind === "header" ? "pb-1.5 pt-3" : "pb-2"}
                >
                  {item.kind === "header" ? (
                    <div className="flex items-center gap-2 px-0.5 text-xs font-medium uppercase tracking-wide text-fg-dim">
                      <span>{item.label}</span>
                      <Badge>{item.count}</Badge>
                    </div>
                  ) : (
                    <PackageRow manifest={item.manifest} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The catalogue for one category, without page chrome, so the Store can host it
 * under a tab alongside the skill marketplace.
 */
export function PluginCatalog({ category }: { category: CatalogCategory }) {
  const [catalog, setCatalog] = useState<PluginManifest[]>(BUNDLED_CATALOG);
  const [installed, setInstalled] = useState<Set<string>>(() => knownInstalledIds(BUNDLED_CATALOG));
  const [states, setStates] = useState<PluginStateMap>(() => loadPluginStates());
  const [query, setQuery] = useState("");
  const [onlyInstalled, setOnlyInstalled] = useState(false);
  const [progress, setProgress] = useState<Record<string, InstallProgress | "starting">>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const abortRefs = useRef<Record<string, AbortController>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const debouncedQuery = useDebounced(query, 120);

  // Device capability is constant for the session, so resolve it once per
  // manifest rather than re-probing navigator for every visible row.
  const unmetByCatalog = useMemo(() => {
    const map = new Map<string, PluginRequirement | null>();
    for (const manifest of catalog) map.set(manifest.id, unmetRequirement(manifest));
    return map;
  }, [catalog]);

  const refreshStorage = useCallback(() => {
    void navigator.storage?.estimate?.().then((e) => setStorage({ usage: e.usage ?? 0, quota: e.quota ?? 0 }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void buildCatalog().then((full) => {
      if (cancelled) return;
      setCatalog(full);
      setInstalled(knownInstalledIds(full));
    });
    refreshStorage();
    return () => {
      cancelled = true;
    };
  }, [refreshStorage]);

  const install = useCallback(
    (manifest: PluginManifest) => {
      setErrors((e) => ({ ...e, [manifest.id]: "" }));
      const controller = new AbortController();
      abortRefs.current[manifest.id] = controller;
      setProgress((p) => ({ ...p, [manifest.id]: "starting" }));

      void installPlugin(manifest, (p) => setProgress((prev) => ({ ...prev, [manifest.id]: p })), controller.signal)
        .then(() => {
          // Refresh the catalogue from persisted installation state.
          setInstalled(knownInstalledIds(catalog));
          setStates(loadPluginStates());
          refreshStorage();
        })
        .catch((err: unknown) => {
          // A WebLLM install fails across a Worker boundary, where an Error
          // does not survive - the rejection is a bare string, so testing for
          // Error hid every real reason an install failed.
          setErrors((e) => ({ ...e, [manifest.id]: localErrorMessage(err, `Installing ${manifest.name} failed.`) }));
        })
        .finally(() => {
          setProgress((p) => {
            const next = { ...p };
            delete next[manifest.id];
            return next;
          });
          delete abortRefs.current[manifest.id];
        });
    },
    [catalog, refreshStorage]
  );

  const uninstall = useCallback(
    (manifest: PluginManifest) => {
      void uninstallPlugin(manifest)
        .catch(() => undefined)
        .then(() => {
          setInstalled(knownInstalledIds(catalog));
          setStates(loadPluginStates());
          refreshStorage();
        });
    },
    [catalog, refreshStorage]
  );

  const cancel = useCallback((manifest: PluginManifest) => {
    abortRefs.current[manifest.id]?.abort();
  }, []);

  const setEnabled = useCallback((manifest: PluginManifest, enabled: boolean) => {
    setStates((current) => {
      const pluginId = String(manifest.config.pluginId ?? manifest.id);
      const next = { ...current, [pluginId]: { ...getPluginState(current, pluginId), enabled } };
      savePluginStates(next);
      return next;
    });
  }, []);

  const wanted = CATEGORY_OF[category];
  const filtered = useMemo(() => {
    const needle = debouncedQuery.trim().toLowerCase();
    return catalog.filter((m) => {
      if (m.category !== wanted) return false;
      if (onlyInstalled && !installed.has(m.id)) return false;
      if (!needle) return true;
      return (
        m.name.toLowerCase().includes(needle) ||
        m.description.toLowerCase().includes(needle) ||
        m.tags.some((t) => t.includes(needle))
      );
    });
  }, [catalog, installed, debouncedQuery, wanted, onlyInstalled]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    // Without this, measured heights are cached by index, so a row's size leaks
    // onto whatever entry lands at that index after a search or tab change.
    getItemKey: (index) => filtered[index]?.id ?? index,
    overscan: 6,
  });

  // Re-measure when the row list changes shape (e.g. a new search result set) -
  // the virtualizer otherwise keeps stale offsets from the previous `filtered`.
  // Missing here until the package catalogue made it obvious: 356 rows filtered
  // down by a debounced query is exactly the case that leaves the list scrolling
  // against the wrong total height.
  useEffect(() => {
    virtualizer.measure();
  }, [filtered, virtualizer]);

  const installedHere = catalog.filter((m) => m.category === wanted && installed.has(m.id)).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          className="flex-1"
          icon={<Search size={13} />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${filtered.length} ${category}...`}
        />
        <Button
          size="sm"
          variant={onlyInstalled ? "primary" : "secondary"}
          onClick={() => setOnlyInstalled((v) => !v)}
        >
          Installed{installedHere > 0 ? ` ${installedHere}` : ""}
        </Button>
      </div>

      {storage && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-fg-faint">
          <HardDrive size={12} className="shrink-0" />
          {formatBytes(storage.usage)} used
          {storage.quota > 0 && ` of about ${formatBytes(storage.quota)} available to this site`}
        </p>
      )}

      <div ref={scrollRef} className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Puzzle size={20} />}
            title={onlyInstalled ? `No ${category} installed yet.` : "Nothing matches that."}
            description={
              onlyInstalled ? "Browse the catalogue and install something to see it here." : undefined
            }
          />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((row) => {
              const manifest = filtered[row.index];
              const pluginId = String(manifest.config.pluginId ?? manifest.id);
              return (
                <div
                  key={manifest.id}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${row.start}px)`,
                  }}
                  className="pb-2"
                >
                  <PluginRow
                    manifest={manifest}
                    installed={installed.has(manifest.id)}
                    phase={progress[manifest.id]}
                    error={errors[manifest.id] || undefined}
                    unmet={unmetByCatalog.get(manifest.id) ?? null}
                    enabled={getPluginState(states, pluginId).enabled}
                    onInstall={install}
                    onUninstall={uninstall}
                    onCancel={cancel}
                    onToggle={setEnabled}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Kept so /plugins still resolves; the Store is the real home. */
export function PluginsView() {
  return (
    <PageShell
      title="Plugins"
      icon={<Puzzle size={24} className="shrink-0 text-accent" />}
      subtitle="Language runtimes installed into your browser."
      bodyScrolls={false}
    >
      <PluginCatalog category="runtimes" />
    </PageShell>
  );
}
