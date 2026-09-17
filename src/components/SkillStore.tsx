import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, Check, Download, Loader2, Plus, Search, Star, Store, Trash2, X } from "lucide-react";
import { useDebounced } from "../lib/useDebounced";
import { Tooltip } from "./Tooltip";
import type { Skill } from "../lib/skills";
import { parseSkillFile, stripResourceBodies } from "../lib/skills";
import { putSkillResources } from "../lib/skillstore";
import {
  GitHubRateLimitError,
  installSkill,
  isRepoShaped,
  loadMarketplace,
  loadMarketplaceRefs,
  parseRepoInput,
  previewSkill,
  saveMarketplaceRefs,
  searchMarketplaces,
  type Marketplace,
  type MarketplaceRef,
  type MarketplaceSkill,
} from "../lib/skillMarketplace";
import { EmptyState } from "./ui";

interface GithubSearchResult {
  repo: string;
  description: string;
  stars: number;
}

/**
 * Browse and install skills from any GitHub repository that publishes the
 * standard `.claude-plugin/marketplace.json`.
 *
 * Nothing installs unread: the full SKILL.md is shown first, because an
 * installed skill injects its instructions into every turn it is invoked on.
 * Repos the user adds themselves are marked untrusted until they say otherwise.
 */
export function SkillStore({
  skills,
  onSaveSkills,
}: {
  skills: Skill[];
  onSaveSkills: (skills: Skill[]) => void;
}) {
  const [refs, setRefs] = useState<MarketplaceRef[]>(() => loadMarketplaceRefs());
  const [markets, setMarkets] = useState<Marketplace[]>([]);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [addValue, setAddValue] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ entry: MarketplaceSkill; text: string } | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debouncedQuery = useDebounced(query, 120);

  // GitHub-wide repo search, triggered by the same "add a marketplace" input
  // whenever it holds free text rather than an owner/repo or github.com URL.
  // Kept independent of `abortRef` above: that one belongs to the coarse
  // "reload every added marketplace" effect, while this fires on nearly every
  // debounced keystroke and must not be cancelled by (or cancel) a reload.
  const [searchResults, setSearchResults] = useState<GithubSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchRateLimitedUntil, setSearchRateLimitedUntil] = useState<number | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);

  const installedSources = useMemo(
    () => new Set(skills.map((s) => s.sourceUrl).filter(Boolean) as string[]),
    [skills]
  );

  const refresh = useCallback((list: MarketplaceRef[]) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setErrors([]);

    void Promise.allSettled(list.map((ref) => loadMarketplace(ref, controller.signal))).then(
      (settled) => {
        if (controller.signal.aborted) return;
        setMarkets(
          settled
            .filter((s): s is PromiseFulfilledResult<Marketplace> => s.status === "fulfilled")
            .map((s) => s.value)
        );
        setErrors(
          settled
            .map((s, i) => (s.status === "rejected" ? `${list[i].repo}: ${String(s.reason?.message ?? s.reason)}` : null))
            .filter((e): e is string => Boolean(e))
        );
        setLoading(false);
      }
    );
  }, []);

  useEffect(() => {
    refresh(refs);
    return () => abortRef.current?.abort();
  }, [refs, refresh]);

  // Free text in the add-marketplace box (anything that isn't a direct
  // owner/repo or github.com URL) searches GitHub instead, debounced well
  // past the 120ms used above - this one spends real, tightly-limited quota
  // (10 unauthenticated requests per 10 minutes, per client IP), while that
  // one just filters an already-loaded, free, local list.
  useEffect(() => {
    const trimmed = addValue.trim();
    if (!trimmed || isRepoShaped(trimmed)) {
      searchAbortRef.current?.abort();
      setSearchResults([]);
      setSearching(false);
      setSearchError(null);
      return;
    }
    if (searchRateLimitedUntil && Date.now() < searchRateLimitedUntil) return;

    const timer = window.setTimeout(() => {
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      setSearching(true);
      setSearchError(null);
      void searchMarketplaces(trimmed, controller.signal)
        .then((results) => {
          if (!controller.signal.aborted) setSearchResults(results);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          if (err instanceof GitHubRateLimitError) {
            setSearchRateLimitedUntil(err.resetAt ?? Date.now() + 60_000);
            setSearchResults([]);
          } else {
            setSearchError(err instanceof Error ? err.message : "GitHub search failed.");
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 600);

    return () => {
      window.clearTimeout(timer);
      searchAbortRef.current?.abort();
    };
  }, [addValue, searchRateLimitedUntil]);

  const addFromSearchResult = (result: GithubSearchResult) => {
    if (refs.some((r) => r.repo === result.repo)) return;
    const next = [...refs, { repo: result.repo, ref: "main" }];
    setRefs(next);
    saveMarketplaceRefs(next);
  };

  const addMarketplace = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const ref = parseRepoInput(addValue);
      if (refs.some((r) => r.repo === ref.repo)) {
        setAddError("That repository is already added.");
        return;
      }
      const next = [...refs, ref];
      setRefs(next);
      saveMarketplaceRefs(next);
      setAddValue("");
      setAddError(null);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Could not read that repository.");
    }
  };

  const removeMarketplace = (repo: string) => {
    const next = refs.filter((r) => r.repo !== repo);
    setRefs(next);
    saveMarketplaceRefs(next);
  };

  const openPreview = (entry: MarketplaceSkill) => {
    setPreviewing(entry.id);
    setInstallError(null);
    void previewSkill(entry)
      .then((text) => setPreview({ entry, text }))
      .catch((err) => setInstallError(err instanceof Error ? err.message : "Could not read that skill."))
      .finally(() => setPreviewing(null));
  };

  const install = (entry: MarketplaceSkill) => {
    setInstalling(entry.id);
    setInstallError(null);
    void installSkill(entry, parseSkillFile)
      .then(async ({ skill, resources }) => {
        if (resources.length > 0) await putSkillResources(skill.id, resources);
        onSaveSkills([...skills, stripResourceBodies(skill)]);
        setPreview(null);
      })
      .catch((err) => setInstallError(err instanceof Error ? err.message : "Install failed."))
      .finally(() => setInstalling(null));
  };

  // Lowercased once per marketplace load rather than per entry per render.
  const searchIndex = useMemo(() => {
    const map = new Map<string, string>();
    for (const market of markets) {
      for (const skill of market.skills) {
        map.set(skill.id, [skill.name, skill.description, skill.collection].join("\n").toLowerCase());
      }
    }
    return map;
  }, [markets]);

  const visible = useMemo(() => {
    const needle = debouncedQuery.trim().toLowerCase();
    return markets
      .map((market) => ({
        market,
        skills: needle
          ? market.skills.filter((s) => (searchIndex.get(s.id) ?? "").includes(needle))
          : market.skills,
      }))
      .filter((m) => m.skills.length > 0);
  }, [markets, debouncedQuery, searchIndex]);

  const total = useMemo(() => markets.reduce((n, m) => n + m.skills.length, 0), [markets]);

  /**
   * Flatten the grouped catalogue into a single row list so it can be
   * virtualized: a marketplace header, then its entries two at a time (they
   * stack to one column below sm). Rendering every marketplace's entries at
   * once mounted hundreds of cards.
   */
  const rows = useMemo(() => {
    const out: ({ kind: "header"; key: string; market: Marketplace } | { kind: "entries"; key: string; items: MarketplaceSkill[] })[] = [];
    for (const { market, skills: entries } of visible) {
      out.push({ kind: "header", key: `h:${market.repo}`, market });
      for (let i = 0; i < entries.length; i += 2) {
        const pair = entries.slice(i, i + 2);
        out.push({ kind: "entries", key: `e:${pair[0].id}`, items: pair });
      }
    }
    return out;
  }, [visible]);

  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (i) => (rows[i]?.kind === "header" ? 56 : 132),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 6,
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${total} skill${total === 1 ? "" : "s"}...`}
            className="h-10 w-full rounded-lg border border-border bg-canvas pl-8 pr-2 text-xs outline-none focus:border-accent"
          />
        </div>
        {loading && <Loader2 size={14} className="animate-spin text-fg-faint" />}
      </div>

      <div className="relative">
        <form onSubmit={addMarketplace} className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
            placeholder="Add a marketplace: owner/repo, a github.com URL, or search a topic"
            className="h-10 min-w-[12rem] flex-1 rounded-lg border border-border bg-canvas px-2.5 text-xs outline-none focus:border-accent"
          />
          <button
            type="submit"
            className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-fg-dim hover:bg-bg-hover hover:text-fg"
          >
            <Plus size={12} /> Add
          </button>
        </form>

        {Boolean(addValue.trim()) && !isRepoShaped(addValue.trim()) && (
          <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-bg-elevated shadow-lift">
            <div className="flex items-center gap-1.5 border-b border-border-subtle px-3 py-2 text-[11px] text-fg-faint">
              {searching ? (
                <>
                  <Loader2 size={11} className="animate-spin" /> Searching GitHub...
                </>
              ) : searchRateLimitedUntil && Date.now() < searchRateLimitedUntil ? (
                "GitHub search rate limit reached"
              ) : searchError ? (
                "Search failed"
              ) : (
                `${searchResults.length} match${searchResults.length === 1 ? "" : "es"} on GitHub`
              )}
            </div>

            {searchRateLimitedUntil && Date.now() < searchRateLimitedUntil ? (
              <p className="px-3 py-3 text-[11px] text-warning">
                Try again in about{" "}
                {Math.max(1, Math.round((searchRateLimitedUntil - Date.now()) / 60_000))} minute
                {Math.max(1, Math.round((searchRateLimitedUntil - Date.now()) / 60_000)) === 1 ? "" : "s"}.
              </p>
            ) : searchError ? (
              <p className="px-3 py-3 text-[11px] text-error">{searchError}</p>
            ) : !searching && searchResults.length === 0 ? (
              <p className="px-3 py-3 text-[11px] text-fg-faint">
                No GitHub repos matched &quot;{addValue.trim()}&quot;.
              </p>
            ) : (
              <ul>
                {searchResults.map((result) => {
                  const alreadyAdded = refs.some((r) => r.repo === result.repo);
                  return (
                    <li
                      key={result.repo}
                      className="flex items-start justify-between gap-2 border-b border-border-subtle px-3 py-2 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium">{result.repo}</span>
                          <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-fg-faint">
                            <Star size={10} /> {result.stars.toLocaleString()}
                          </span>
                        </div>
                        <p className="line-clamp-2 text-[11px] text-fg-faint">
                          {result.description || "No description."}
                        </p>
                      </div>
                      {alreadyAdded ? (
                        <span className="flex shrink-0 items-center gap-1 text-[11px] text-success">
                          <Check size={11} /> Added
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => addFromSearchResult(result)}
                          className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-fg-dim hover:bg-bg-hover hover:text-fg"
                        >
                          <Plus size={11} /> Add
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
      {addError && <p className="mt-1.5 text-xs text-error">{addError}</p>}
      {installError && <p className="mt-1.5 text-xs text-error">{installError}</p>}
      {errors.map((e) => (
        <p key={e} className="mt-1.5 flex items-start gap-1 text-xs text-warning">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {e}
        </p>
      ))}

      <div ref={listRef} className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
        {!loading && visible.length === 0 && (
          <EmptyState
            title={debouncedQuery.trim() ? "No skills match that search." : "No marketplaces loaded."}
          />
        )}

        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((row) => {
            const item = rows[row.index];
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${row.start}px)`,
                }}
              >
                {item.kind === "header" ? (
                  <div className="flex items-center gap-2 pb-2 pt-4 first:pt-0">
                    <Store size={14} className="shrink-0 text-accent" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{item.market.name}</span>
                        {!item.market.trusted && (
                          <span className="shrink-0 rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
                            Untrusted
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-fg-faint">
                        {item.market.repo} · {item.market.owner}
                        {item.market.version ? ` · v${item.market.version}` : ""}
                      </div>
                    </div>
                    <Tooltip label="Remove this marketplace">
                      <button
                        type="button"
                        onClick={() => removeMarketplace(item.market.repo)}
                        aria-label={`Remove ${item.market.repo}`}
                        className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-fg-faint hover:bg-bg-hover hover:text-error"
                      >
                        <Trash2 size={14} />
                      </button>
                    </Tooltip>
                  </div>
                ) : (
                  <div className="grid gap-2 pb-2 sm:grid-cols-2">
                    {item.items.map((entry) => {
                      const installed = installedSources.has(entry.sourceUrl);
                      return (
                        <div
                          key={entry.id}
                          className="flex flex-col rounded-xl border border-border-subtle bg-bg-elevated p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="min-w-0 break-words text-xs font-medium">{entry.name}</span>
                            <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-fg-faint">
                              {entry.collection}
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-fg-faint">
                            {entry.description || "No description."}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => openPreview(entry)}
                              disabled={previewing === entry.id}
                              className="h-9 rounded-md border border-border px-2.5 text-[11px] text-fg-dim hover:bg-bg-hover hover:text-fg disabled:opacity-60"
                            >
                              {previewing === entry.id ? "Loading..." : "View"}
                            </button>
                            {installed ? (
                              <span className="flex items-center gap-1 text-[11px] text-success">
                                <Check size={11} /> Installed
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => install(entry)}
                                disabled={installing === entry.id}
                                className="flex h-9 items-center gap-1 rounded-md bg-accent px-2.5 text-[11px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-60"
                              >
                                {installing === entry.id ? (
                                  <Loader2 size={11} className="animate-spin" />
                                ) : (
                                  <Download size={11} />
                                )}
                                Install
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-overlay/40 p-0 sm:items-center sm:p-4">
          <div className="flex max-h-[85vh] w-full flex-col rounded-t-2xl border border-border bg-bg-elevated shadow-lift sm:max-h-[80vh] sm:max-w-2xl sm:rounded-2xl">
            <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
              <span className="truncate text-sm font-medium">{preview.entry.name}</span>
              <a
                href={preview.entry.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[11px] text-fg-faint hover:text-fg"
              >
                source
              </a>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="ml-auto rounded-md p-1 text-fg-faint hover:bg-bg-hover hover:text-fg"
              >
                <X size={15} />
              </button>
            </div>
            <p className="border-b border-border-subtle px-4 py-2 text-[11px] leading-4 text-fg-faint">
              These instructions are injected into every turn you invoke this skill on. Read them
              before installing.
            </p>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-sans text-xs leading-5 text-fg-dim">
              {preview.text}
            </pre>
            <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-4 py-3">
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-fg-dim hover:bg-bg-hover hover:text-fg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => install(preview.entry)}
                disabled={installing === preview.entry.id}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hover disabled:opacity-60"
              >
                {installing === preview.entry.id && <Loader2 size={12} className="animate-spin" />}
                Install skill
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
