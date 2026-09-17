import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronDown, Cpu, Eye, Film, Plus, Search, Unlock, Wrench } from "lucide-react";
import type { ProviderPluginModel } from "../lib/types";

function fmtCtx(n?: number): string | null {
  if (!n) return null;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function Badge({ icon: Icon, label }: { icon: typeof Eye; label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border-subtle bg-bg-elevated px-1.5 py-0.5 text-[10px] text-fg-dim">
      <Icon size={10} />
      {label}
    </span>
  );
}

/** Debounces the search box so filtering a huge discovered catalog doesn't run on every keystroke. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const ROW_HEIGHT = 52;
const PANEL_GAP = 6;
const PANEL_MARGIN = 12;
const PANEL_MIN_WIDTH = 280;
/** Room the search box + select-all row + paddings take above the scrollable row list. */
const PANEL_HEADER_RESERVE = 96;

interface PanelPosition {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

interface ModelMultiSelectProps {
  models: ProviderPluginModel[];
  onChange: (models: ProviderPluginModel[]) => void;
}

/**
 * Virtualized, checkbox-based replacement for the old comma-separated
 * Models text field — a closed trigger showing an enabled/total count that
 * opens a floating, searchable, virtualized checkbox list. Rendered via a
 * portal to document.body and positioned with `fixed` coordinates anchored
 * to the trigger, so it's never clipped by SettingsModal's own
 * `overflow-y-auto`/`overflow-hidden` scroll containers and always shows
 * in full — flipping above the trigger when there's more room there.
 * Disabling a model here excludes it from "auto" routing and the chat
 * model picker (see modelsFromProviders/autoRoute.ts) but keeps it
 * remembered — re-discovering preserves each model's enabled state.
 */
export function ModelMultiSelect({ models, onChange }: ModelMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounced(query, 120);
  const scrollRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PanelPosition | null>(null);

  const enabledCount = useMemo(() => models.filter((m) => m.enabled !== false).length, [models]);

  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.id.toLowerCase().includes(q));
  }, [models, debouncedQuery]);

  const trimmedQuery = debouncedQuery.trim();
  const showAddRow = trimmedQuery !== "" && filtered.length === 0;

  // Keep the floating panel anchored to the trigger, flipping above it when
  // there's more room there, and re-measure on scroll (capture:true so it
  // also catches scrolling inside SettingsModal's own scroll container) and
  // resize so it never drifts away from the trigger while open.
  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.max(rect.width, PANEL_MIN_WIDTH);
      const left = Math.min(rect.left, window.innerWidth - width - PANEL_MARGIN);
      const spaceBelow = window.innerHeight - rect.bottom - PANEL_MARGIN;
      const spaceAbove = rect.top - PANEL_MARGIN;
      if (spaceBelow >= 220 || spaceBelow >= spaceAbove) {
        setPosition({ left, width, maxHeight: Math.max(160, spaceBelow), top: rect.bottom + PANEL_GAP });
      } else {
        setPosition({ left, width, maxHeight: Math.max(160, spaceAbove), bottom: window.innerHeight - rect.top + PANEL_GAP });
      }
    };
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open]);

  // Close on an outside click or Escape — needed now that the panel floats
  // above the page instead of expanding inline.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [filtered.length, virtualizer]);

  const toggleModel = (id: string) => {
    onChange(models.map((m) => (m.id === id ? { ...m, enabled: m.enabled === false } : m)));
  };

  const setAllFiltered = (enabled: boolean) => {
    const ids = new Set(filtered.map((m) => m.id));
    onChange(models.map((m) => (ids.has(m.id) ? { ...m, enabled } : m)));
  };

  const addCustomModel = () => {
    const id = query.trim();
    if (!id) return;
    if (models.some((m) => m.id === id)) {
      onChange(models.map((m) => (m.id === id ? { ...m, enabled: true } : m)));
    } else {
      onChange([...models, { id, enabled: true }]);
    }
    setQuery("");
  };

  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-lg border border-border bg-canvas px-3 py-2 text-left text-xs text-fg-dim hover:border-accent"
      >
        <span>{models.length === 0 ? "No models yet" : `${enabledCount}/${models.length} models enabled`}</span>
        <ChevronDown size={14} className={`shrink-0 text-fg-faint transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: "fixed",
              top: position.top,
              bottom: position.bottom,
              left: position.left,
              width: position.width,
              maxHeight: position.maxHeight,
            }}
            className="z-[70] flex flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated p-2 shadow-lift"
          >
            <div className="flex items-center gap-2 rounded-lg border border-border bg-canvas px-2.5 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
              <Search size={13} className="shrink-0 text-fg-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && showAddRow) {
                    e.preventDefault();
                    addCustomModel();
                  }
                }}
                placeholder="Search or add a model id…"
                spellCheck={false}
                autoFocus
                className="w-full bg-transparent text-xs outline-none placeholder:text-fg-faint"
              />
            </div>

            {filtered.length > 0 && (
              <div className="mt-1.5 flex shrink-0 items-center gap-3 px-0.5">
                <button type="button" onClick={() => setAllFiltered(true)} className="text-[11px] text-fg-dim hover:text-fg">
                  Select all
                </button>
                <button type="button" onClick={() => setAllFiltered(false)} className="text-[11px] text-fg-dim hover:text-fg">
                  Deselect all
                </button>
              </div>
            )}

            {showAddRow && (
              <button
                type="button"
                onClick={addCustomModel}
                className="mt-1.5 flex w-full shrink-0 items-center gap-2 rounded-md border border-dashed border-border px-2 py-1.5 text-left text-xs text-fg-dim hover:border-accent hover:text-fg"
              >
                <Plus size={12} className="shrink-0" />
                Add “{trimmedQuery}” as a new model
              </button>
            )}

            <div
              ref={scrollRef}
              style={{ maxHeight: Math.max(120, position.maxHeight - PANEL_HEADER_RESERVE) }}
              className="mt-1.5 overflow-y-auto"
            >
              {filtered.length === 0 ? (
                !showAddRow && (
                  <div className="px-2 py-6 text-center text-xs text-fg-faint">No models yet — discover or add one above.</div>
                )
              ) : (
                <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                  {virtualizer.getVirtualItems().map((virtualRow) => {
                    const model = filtered[virtualRow.index];
                    const enabled = model.enabled !== false;
                    const ctx = fmtCtx(model.contextLength);
                    return (
                      <div
                        key={model.id}
                        data-index={virtualRow.index}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => toggleModel(model.id)}
                          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-bg-hover"
                        >
                          <span
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                              enabled ? "border-accent bg-accent text-on-accent" : "border-border bg-canvas"
                            }`}
                          >
                            {enabled && <Check size={11} />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-medium">{model.id}</div>
                            {(ctx ||
                              model.supportsVision ||
                              model.supportsVideo ||
                              model.supportsReasoning ||
                              model.toolCalling ||
                              model.freeAccess) && (
                              <div className="mt-0.5 flex items-center gap-1 overflow-hidden">
                                {ctx && <Badge icon={Cpu} label={`${ctx} context`} />}
                                {model.supportsVision && <Badge icon={Eye} label="Vision" />}
                                {model.supportsVideo && <Badge icon={Film} label="Video" />}
                                {model.supportsReasoning && <Badge icon={Wrench} label="Reasoning" />}
                                {model.toolCalling && <Badge icon={Check} label="Tools" />}
                                {model.freeAccess && <Badge icon={Unlock} label="No key needed" />}
                              </div>
                            )}
                          </div>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
