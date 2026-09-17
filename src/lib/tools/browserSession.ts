import { readUrlHtml, readUrlText } from "../reader";

/**
 * The agent's browsing session.
 *
 * A static page cannot script a cross-origin iframe, so real click automation
 * on arbitrary sites is not possible without an extension - that is a browser
 * security boundary, not a gap in this code. What *is* possible works on every
 * site: fetch a page as text through the CORS-enabled reader, expose its links
 * and forms, and navigate by following them. That covers reading, searching,
 * multi-hop research and GET-form submission, which is most of what an agent
 * actually needs the web for.
 *
 * The live pane (components/BrowserPanel.tsx) shows the extracted text (what
 * the model reads) plus, lazily, a fetched DOM snapshot for a "Rendered"
 * preview. State lives here so both the tools and the pane read the same
 * session, and so it survives the pane being mounted/unmounted (dismissed and
 * reopened via `showBrowser()`) without losing anything already fetched.
 */

export interface PageLink {
  index: number;
  text: string;
  url: string;
}

export interface BrowserPage {
  url: string;
  title: string;
  text: string;
  links: PageLink[];
  fetchedAt: number;
  /** Lazy DOM snapshot for the "Rendered" tab, cached per-page so revisiting
   * via back/forward never re-fetches. Absent until requested. */
  renderedHtml?: string;
  /** Set instead of renderedHtml if the snapshot fetch failed. */
  renderedError?: string;
}

export interface BrowserState {
  /** Always === history[historyIndex] (or null when history is empty). Kept
   * as its own field so every existing `state.page` read (BrowserPanel.tsx,
   * browserTools.ts's currentPage()) needs zero changes. */
  page: BrowserPage | null;
  /** Full cached pages, not just URLs, so Back/Forward is instant. */
  history: BrowserPage[];
  /** Pointer into `history`; -1 when history is empty. */
  historyIndex: number;
  loading: boolean;
  error: string | null;
  /** Whether the user has closed the dock/sheet for the current page. Lives
   * here (rather than as local state in BrowserPanel) so a chat bubble far
   * away in the component tree — the "Using tools: browser_open" chip on a
   * past message — can bring the dock back with no prop drilling, the same
   * way it can already read `page`. */
  dismissed: boolean;
  /** True while a rendered-snapshot fetch is in flight. Transient, not
   * per-page - "loading" only ever means "one is happening right now". */
  renderedLoading: boolean;
}

type Listener = (state: BrowserState) => void;

const MAX_LINKS = 60;
const PAGE_TEXT_LIMIT = 20_000;
const MAX_HISTORY = 30;

let state: BrowserState = {
  page: null,
  history: [],
  historyIndex: -1,
  loading: false,
  error: null,
  dismissed: false,
  renderedLoading: false,
};
const listeners = new Set<Listener>();

/** Bumped on every real navigation (openPage); invalidates a still-in-flight
 * loadRenderedHtml() fetch for the page being left. */
let renderGeneration = 0;

function publish(next: Partial<BrowserState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) {
    try {
      listener(state);
    } catch {
      /* a broken subscriber must never break a tool call */
    }
  }
}

export function onBrowserState(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export function browserState(): BrowserState {
  return state;
}

export function resetBrowser(): void {
  renderGeneration++;
  publish({
    page: null,
    history: [],
    historyIndex: -1,
    loading: false,
    error: null,
    dismissed: false,
    renderedLoading: false,
  });
}

/** Reopen the dock/sheet for whatever page is currently in the session
 * (a no-op if nothing has been fetched yet). */
export function showBrowser(): void {
  publish({ dismissed: false });
}

/** Close the dock/sheet without discarding the session. */
export function hideBrowser(): void {
  publish({ dismissed: true });
}

/** Markdown links, as the reader emits them: `[text](url)`. */
function extractLinks(markdown: string, base: string): PageLink[] {
  const links: PageLink[] = [];
  const seen = new Set<string>();
  const re = /\[([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(markdown)) && links.length < MAX_LINKS) {
    const text = match[1].replace(/\s+/g, " ").trim();
    let url = match[2];
    try {
      url = new URL(url, base).toString();
    } catch {
      continue;
    }
    if (!text || seen.has(url)) continue;
    seen.add(url);
    links.push({ index: links.length + 1, text, url });
  }
  return links;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("No URL given.");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be opened.");
  }
  return url.toString();
}

/** Fetch a URL into the session and make it the current page (a fresh
 * navigation - from a tool call, the address bar, or a clicked link). */
export async function openPage(rawUrl: string, signal?: AbortSignal): Promise<BrowserPage> {
  const url = normalizeUrl(rawUrl);
  publish({ loading: true, error: null });
  try {
    const result = await readUrlText(url, signal, PAGE_TEXT_LIMIT);
    const page: BrowserPage = {
      url: result.url || url,
      title: result.title,
      text: result.text,
      links: extractLinks(result.text, result.url || url),
      fetchedAt: Date.now(),
    };
    renderGeneration++; // a real navigation - any in-flight render fetch is now stale

    // Standard browser semantics: drop any forward entries past the current
    // pointer, then always push a new entry (revisiting a URL is a real
    // reload, not a jump back to the cached copy - no dedup here).
    let nextHistory = [...state.history.slice(0, state.historyIndex + 1), page];
    if (nextHistory.length > MAX_HISTORY) {
      nextHistory = nextHistory.slice(nextHistory.length - MAX_HISTORY);
    }
    publish({
      page,
      loading: false,
      dismissed: false,
      history: nextHistory,
      historyIndex: nextHistory.length - 1, // recomputed after push+cap, never desyncs
    });
    return page;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to open the page.";
    publish({ loading: false, error: message });
    throw new Error(message);
  }
}

/** Step back to the previous page in history. Instant - no network call,
 * the page is already cached. */
export function goBack(): void {
  if (state.historyIndex <= 0) return;
  const historyIndex = state.historyIndex - 1;
  publish({ historyIndex, page: state.history[historyIndex], dismissed: false, error: null });
}

/** Step forward to the next page in history. Instant - no network call. */
export function goForward(): void {
  if (state.historyIndex >= state.history.length - 1) return;
  const historyIndex = state.historyIndex + 1;
  publish({ historyIndex, page: state.history[historyIndex], dismissed: false, error: null });
}

/** Write a render result into `target` (by identity) in both `history` and,
 * if it is still the current page, `state.page` - but only if nothing
 * navigated away from `target` while the fetch was in flight. */
function applyRenderedResult(
  target: BrowserPage,
  myGeneration: number,
  patch: Pick<BrowserPage, "renderedHtml" | "renderedError">
): void {
  if (renderGeneration !== myGeneration) return; // a real navigation happened meanwhile - discard
  const idx = state.history.indexOf(target); // identity, not URL: a fresh revisit of the
  if (idx === -1) return; // same URL creates a distinct object; this one may have been evicted/superseded
  const patched: BrowserPage = { ...target, ...patch };
  const history = state.history.slice();
  history[idx] = patched;
  publish({ history, ...(state.page === target ? { page: patched } : {}) });
}

/** Lazily fetch and cache the DOM snapshot for the current page's "Rendered"
 * tab. A no-op if already loading, or if the current page already has a
 * *successful* cached result - a previous error is always retried when this
 * is called again (the panel's effect re-fires on tab revisit). */
export async function loadRenderedHtml(signal?: AbortSignal): Promise<void> {
  const target = state.page; // capture identity BEFORE the await
  if (!target || state.renderedLoading) return;
  if (target.renderedHtml !== undefined) return; // only a success short-circuits - not a prior error

  const myGeneration = renderGeneration;
  publish({ renderedLoading: true });
  try {
    const html = await readUrlHtml(target.url, signal);
    applyRenderedResult(target, myGeneration, { renderedHtml: html });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to render the page.";
    applyRenderedResult(target, myGeneration, { renderedError: message });
  } finally {
    if (renderGeneration === myGeneration) publish({ renderedLoading: false });
  }
}

function stripScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "").replace(/<script\b[^>]*\/>/gi, "");
}

function injectBaseHref(html: string, pageUrl: string): string {
  const base = `<base href="${pageUrl.replace(/"/g, "&quot;")}">`;
  const headOpen = /<head[^>]*>/i.exec(html);
  if (!headOpen) return base + html;
  const idx = headOpen.index + headOpen[0].length;
  return html.slice(0, idx) + base + html.slice(idx);
}

/** Prep a fetched DOM snapshot for display: strip <script> tags (belt-and-
 * suspenders alongside the iframe sandbox, which already omits allow-scripts)
 * and inject a <base> so relative images/CSS/links resolve against the real
 * page instead of about:srcdoc. */
export function prepareSnapshotHtml(html: string, pageUrl: string): string {
  return injectBaseHref(stripScripts(html), pageUrl);
}

export function currentPage(): BrowserPage {
  if (!state.page) throw new Error("No page is open. Call browser_open with a URL first.");
  return state.page;
}

/** Resolve a link by 1-based index or by (case-insensitive) link text. */
export function resolveLink(target: string): PageLink {
  const page = currentPage();
  const asIndex = Number.parseInt(target, 10);
  if (!Number.isNaN(asIndex)) {
    const byIndex = page.links.find((l) => l.index === asIndex);
    if (byIndex) return byIndex;
  }
  const needle = target.toLowerCase();
  const exact = page.links.find((l) => l.text.toLowerCase() === needle);
  if (exact) return exact;
  const partial = page.links.find((l) => l.text.toLowerCase().includes(needle));
  if (partial) return partial;
  throw new Error(
    `No link matching "${target}" on this page. Call browser_links to see what is available.`
  );
}

/** Build a search URL for the keyless engine the app already uses. */
export function searchUrl(query: string): string {
  return `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
}
