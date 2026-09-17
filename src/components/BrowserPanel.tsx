import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  Globe,
  Loader2,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import {
  goBack,
  goForward,
  hideBrowser,
  loadRenderedHtml,
  onBrowserState,
  openPage,
  prepareSnapshotHtml,
  resetBrowser,
  type BrowserState,
} from "../lib/tools/browserSession";
import { Markdown } from "./Markdown";
import { Tooltip } from "./Tooltip";

const HIGHLIGHT_SUPPORTED = typeof CSS !== "undefined" && "highlights" in CSS;

function collectMatches(container: HTMLElement, query: string): Range[] {
  if (!query.trim()) return [];
  const needle = query.toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const text = node.textContent ?? "";
    const lower = text.toLowerCase();
    let from = 0;
    let at: number;
    while ((at = lower.indexOf(needle, from)) !== -1) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      from = at + needle.length;
    }
  }
  return ranges;
}

interface TocHeading {
  level: number;
  text: string;
}

const ATX_HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/** Parse ATX (`#`) headings from raw markdown, in document order, skipping
 * fenced and indented code blocks so a `#`-looking line inside one isn't
 * mistaken for a real heading (react-markdown wouldn't render it as one
 * either, which would desync the heading-index-to-DOM-element mapping used
 * to scroll to a TOC entry). */
function extractHeadings(markdown: string): TocHeading[] {
  const headings: TocHeading[] = [];
  let inFence = false;
  let fenceChar = "";
  for (const rawLine of markdown.split("\n")) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(rawLine);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!inFence) {
        inFence = true;
        fenceChar = marker[0];
      } else if (marker[0] === fenceChar) {
        inFence = false;
      }
      continue;
    }
    if (inFence || /^ {4,}\S/.test(rawLine)) continue;
    const m = ATX_HEADING_RE.exec(rawLine);
    if (m) headings.push({ level: m[1].length, text: m[2] });
  }
  return headings;
}

/**
 * Live view of the agent's browsing session.
 *
 * Two layers: Text, the extracted markdown that works on every site (this is
 * what the model reads), and Rendered, a DOM snapshot fetched lazily from the
 * same reader endpoint in a different response format. We're not framing the
 * *live* cross-origin URL - that's why X-Frame-Options used to block it on
 * most sites - we're framing our own fetched-and-sanitized copy via `srcdoc`,
 * which is why it now works on most sites for the first paint (a link
 * clicked inside it still opens a real new tab rather than trying to
 * navigate the sandboxed frame into a second live page).
 *
 * The panel is a viewer, not a driver: the model navigates through the browser
 * tools, and this shows what it is looking at.
 */
export function BrowserPanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<BrowserState>({
    page: null,
    history: [],
    historyIndex: -1,
    loading: false,
    error: null,
    dismissed: false,
    renderedLoading: false,
  });
  const [view, setView] = useState<"text" | "render">("text");
  const [address, setAddress] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatches, setFindMatches] = useState<Range[]>([]);
  const [findActive, setFindActive] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => onBrowserState(setState), []);
  useEffect(() => {
    if (state.page) setAddress(state.page.url);
  }, [state.page?.url]);

  const go = (e: React.FormEvent) => {
    e.preventDefault();
    if (address.trim()) void openPage(address).catch(() => undefined);
  };

  // Fetch the Rendered-tab snapshot when the user opens that tab. Keyed on
  // historyIndex (not state.page or its URL): historyIndex changes exactly on
  // real navigation (openPage push, back, forward) and never when
  // loadRenderedHtml() patches a cached page's renderedHtml/renderedError in
  // place - so a completed fetch never re-triggers itself into a loop, but
  // switching Text -> Rendered again after a failure still retries (`view`
  // is also in the dependency array).
  useEffect(() => {
    if (view !== "render" || !state.page) return;
    const controller = new AbortController();
    void loadRenderedHtml(controller.signal);
    return () => controller.abort();
  }, [view, state.historyIndex]);

  const headings = useMemo(() => (state.page ? extractHeadings(state.page.text) : []), [state.page?.text]);

  // In-page find: highlights are a paint-time overlay via the CSS Custom
  // Highlight API, never DOM mutations, so they can't fight React's
  // ownership of the rendered Markdown subtree.
  useEffect(() => {
    if (!findOpen || !containerRef.current) {
      if (HIGHLIGHT_SUPPORTED) {
        CSS.highlights.delete("browser-find-all");
        CSS.highlights.delete("browser-find-active");
      }
      return;
    }
    const matches = collectMatches(containerRef.current, findQuery);
    setFindMatches(matches);
    setFindActive(0);
    if (HIGHLIGHT_SUPPORTED) {
      CSS.highlights.set("browser-find-all", new Highlight(...matches));
      CSS.highlights.set("browser-find-active", new Highlight(...(matches[0] ? [matches[0]] : [])));
    }
    matches[0]?.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
    return () => {
      if (HIGHLIGHT_SUPPORTED) {
        CSS.highlights.delete("browser-find-all");
        CSS.highlights.delete("browser-find-active");
      }
    };
  }, [findOpen, findQuery, state.page?.text]);

  const jumpFind = (direction: 1 | -1) => {
    if (findMatches.length === 0) return;
    const next = (findActive + direction + findMatches.length) % findMatches.length;
    setFindActive(next);
    const range = findMatches[next];
    if (HIGHLIGHT_SUPPORTED) CSS.highlights.set("browser-find-active", new Highlight(range));
    range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const closeFind = () => {
    setFindOpen(false);
    setFindQuery("");
  };

  const jumpToHeading = (i: number) => {
    const el = containerRef.current?.querySelectorAll("h1,h2,h3,h4,h5,h6")[i] as HTMLElement | undefined;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (window.matchMedia("(max-width: 1023px)").matches) setTocOpen(false);
  };

  return (
    <div className="flex h-full flex-col border-l border-border bg-bg-elevated">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <Globe size={15} className="shrink-0 text-accent" />
        <span className="text-sm font-medium">Browser</span>
        {state.loading && <Loader2 size={13} className="animate-spin text-fg-faint" />}
        <div className="ml-auto flex items-center gap-1">
          <Tooltip label="Clear session">
            <button
              type="button"
              onClick={() => resetBrowser()}
              aria-label="Clear session"
              className="rounded-md p-1 text-fg-faint hover:bg-bg-hover hover:text-fg"
            >
              <RotateCcw size={14} />
            </button>
          </Tooltip>
          <Tooltip label="Close">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1 text-fg-faint hover:bg-bg-hover hover:text-fg"
            >
              <X size={15} />
            </button>
          </Tooltip>
        </div>
      </div>

      <form onSubmit={go} className="flex items-center gap-1.5 border-b border-border-subtle px-3 py-2">
        <Tooltip label="Back">
          <button
            type="button"
            onClick={() => goBack()}
            disabled={state.historyIndex <= 0}
            aria-label="Back"
            className="shrink-0 rounded-md p-1.5 text-fg-faint hover:bg-bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Forward">
          <button
            type="button"
            onClick={() => goForward()}
            disabled={state.historyIndex >= state.history.length - 1}
            aria-label="Forward"
            className="shrink-0 rounded-md p-1.5 text-fg-faint hover:bg-bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronRight size={14} />
          </button>
        </Tooltip>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Enter a URL"
          className="min-w-0 flex-1 rounded-lg border border-border bg-canvas px-2.5 py-1.5 text-xs outline-none focus:border-accent"
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-fg-dim hover:bg-bg-hover hover:text-fg"
        >
          Go
        </button>
      </form>

      {state.page && (
        <div className="flex items-center gap-1 border-b border-border-subtle px-3 py-1.5">
          {(["text", "render"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                view === mode ? "bg-accent/10 text-accent" : "text-fg-faint hover:bg-bg-hover hover:text-fg"
              }`}
            >
              {mode === "text" ? "Text" : "Rendered"}
            </button>
          ))}
          {view === "text" && (
            <Tooltip label="Find in page">
              <button
                type="button"
                onClick={() => setFindOpen((v) => !v)}
                aria-label="Find in page"
                className={`rounded-md p-1 ${findOpen ? "text-accent" : "text-fg-faint"} hover:bg-bg-hover hover:text-fg`}
              >
                <Search size={13} />
              </button>
            </Tooltip>
          )}
          <a
            href={state.page.url}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-fg-faint hover:text-fg"
          >
            Open <ExternalLink size={11} />
          </a>
        </div>
      )}

      {findOpen && view === "text" && state.page && (
        <div className="flex items-center gap-1.5 border-b border-border-subtle bg-bg-elevated px-3 py-1.5">
          <input
            autoFocus
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            placeholder="Find in page"
            className="min-w-0 flex-1 rounded-md border border-border bg-canvas px-2 py-1 text-xs outline-none focus:border-accent"
          />
          <span className="shrink-0 text-[11px] tabular-nums text-fg-faint">
            {findMatches.length > 0 ? `${findActive + 1}/${findMatches.length}` : "0/0"}
          </span>
          <button
            type="button"
            onClick={() => jumpFind(-1)}
            disabled={findMatches.length === 0}
            className="rounded-md p-1 text-fg-faint hover:bg-bg-hover hover:text-fg disabled:opacity-30"
          >
            <ChevronUp size={13} />
          </button>
          <button
            type="button"
            onClick={() => jumpFind(1)}
            disabled={findMatches.length === 0}
            className="rounded-md p-1 text-fg-faint hover:bg-bg-hover hover:text-fg disabled:opacity-30"
          >
            <ChevronDown size={13} />
          </button>
          <button type="button" onClick={closeFind} className="rounded-md p-1 text-fg-faint hover:bg-bg-hover hover:text-fg">
            <X size={13} />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {state.error && (
          <p className="m-3 rounded-lg border border-error/30 bg-error/5 p-2.5 text-xs text-error">{state.error}</p>
        )}

        {!state.page && !state.error && (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
            <Globe size={22} className="text-fg-faint" />
            <p className="text-xs text-fg-dim">No page open yet.</p>
            <p className="text-[11px] leading-4 text-fg-faint">
              Ask the assistant to look something up, or type a URL above. Pages are fetched as text,
              so this works on sites that refuse to be embedded.
            </p>
          </div>
        )}

        {state.page && view === "text" && (
          <div className="p-3">
            <div className="text-sm font-medium">{state.page.title || "Untitled"}</div>
            <div className="mt-0.5 break-all text-[11px] text-fg-faint">{state.page.url}</div>
            {headings.length >= 2 && (
              <div className="mt-3 rounded-lg border border-border-subtle">
                <button
                  type="button"
                  onClick={() => setTocOpen((v) => !v)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs font-medium text-fg-dim hover:text-fg"
                >
                  <ChevronDown size={13} className={`transition-transform ${tocOpen ? "rotate-180" : ""}`} />
                  Contents
                </button>
                {tocOpen && (
                  <ul className="border-t border-border-subtle px-2.5 py-1.5 text-xs">
                    {headings.map((h, i) => (
                      <li key={i} style={{ paddingLeft: `${(h.level - 1) * 12}px` }}>
                        <button
                          type="button"
                          onClick={() => jumpToHeading(i)}
                          className="w-full truncate py-0.5 text-left text-fg-dim hover:text-accent"
                        >
                          {h.text}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="mt-3" ref={containerRef}>
              <Markdown
                text={state.page.text}
                onLinkClick={(href) => {
                  // Fetched pages often link with a site-relative href (e.g.
                  // "/wiki/Foo"); resolve it against the current page's URL
                  // before opening, or normalizeUrl() would misread it as a
                  // bare hostname and prepend https:// to a path.
                  let resolved = href;
                  try {
                    resolved = new URL(href, state.page!.url).toString();
                  } catch {
                    /* keep href as-is; openPage will surface the error */
                  }
                  void openPage(resolved).catch(() => undefined);
                }}
              />
            </div>
          </div>
        )}

        {state.page && view === "render" && (
          <div className="flex h-full flex-col">
            {state.renderedLoading && (
              <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
                <Loader2 size={18} className="animate-spin text-fg-faint" />
                <p className="text-xs text-fg-dim">Rendering a snapshot of the page…</p>
              </div>
            )}
            {state.page.renderedError && !state.renderedLoading && (
              <p className="m-3 rounded-lg border border-error/30 bg-error/5 p-2.5 text-xs text-error">
                {state.page.renderedError}
              </p>
            )}
            {state.page.renderedHtml && !state.renderedLoading && (
              <iframe
                key={state.page.url}
                srcDoc={prepareSnapshotHtml(state.page.renderedHtml, state.page.url)}
                title="Browser preview"
                sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                referrerPolicy="no-referrer"
                className="min-h-0 w-full flex-1 border-0 bg-white"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Shows the browser pane once the agent actually opens something, and stays out
 * of the way until then. Dismissing it hides the dock until the next
 * navigation (or until something calls `showBrowser()` — see the
 * "Using tools: browser_open" chip on past messages in MessageBubble.tsx),
 * so it never becomes a permanent obstruction.
 */
export function BrowserDock() {
  const [hasPage, setHasPage] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(
    () =>
      onBrowserState((s) => {
        setHasPage(Boolean(s.page));
        setDismissed(s.dismissed);
      }),
    []
  );

  if (!hasPage || dismissed) return null;
  const dismiss = () => hideBrowser();

  return (
    <>
      {/* Desktop: a right-hand dock. It is fixed rather than in flow, so it
          dims the page behind it and closes on outside click - otherwise it
          would silently cover the right edge of whatever page is mounted, with
          nothing reserving space for it. */}
      <div className="hidden lg:block">
        <div className="fixed inset-0 z-20 bg-overlay/20" onClick={dismiss} />
        <div className="fixed right-0 top-0 z-30 h-full w-[min(28rem,40vw)] shadow-lift">
          <BrowserPanel onClose={dismiss} />
        </div>
      </div>

      {/* Below lg there is no room for a dock, so use the same bottom sheet the
          artifact panel uses on mobile rather than hiding browsing entirely. */}
      <div className="fixed inset-0 z-40 flex flex-col lg:hidden">
        <div className="absolute inset-0 bg-overlay/60" onClick={dismiss} />
        <div className="relative z-10 mt-auto flex h-[85%] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-bg-elevated shadow-lift">
          <BrowserPanel onClose={dismiss} />
        </div>
      </div>
    </>
  );
}
