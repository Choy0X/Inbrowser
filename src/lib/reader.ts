import type { SearchResult } from "./types";
import { providerFetch } from "./gateway/providerFetch";
import { activeProxyOrUndefined } from "./gateway/activeProxy";

export interface PageExcerpt {
  /** Index into the parent search results array (for citation numbering). */
  resultIndex: number;
  url: string;
  title: string;
  text: string;
}

const MAX_READER_PAGES = 3;

/**
 * Jina's reader renders any URL to clean text and is one of the very few page
 * fetchers that sends CORS headers, so it can be called straight from the
 * browser. That matters beyond convenience: the request originates from the
 * user's own IP, so its rate limit (20 requests/minute) is per-user rather
 * than shared across everyone using this app - the same reason the default path
 * has no hop of its own. See gateway/providerFetch.ts.
 *
 * Goes through providerFetch rather than a bare fetch so that a configured proxy
 * applies here too: a user who set one up to reach a blocked provider would
 * otherwise still read pages from their own address. tools/browserTools.ts
 * reaches the network only through this module, so AI browser use inherits it.
 */
const READER_ENDPOINT = "https://r.jina.ai/";

/** Cap on characters kept per page, mirroring what the old server-side reader returned. */
const MAX_TEXT = 6000;

/** Requests in flight at once. Kept low so three pages never trip the per-minute budget. */
const CONCURRENCY = 2;

const READER_TIMEOUT_MS = 12_000;

/** A bullet-list line whose entire content is one image link, optionally
 * followed by a short trailing label (e.g. "Follow us") - Jina's rendering of
 * a social-follow/logo icon row: `* [![Instagram logo](icon.svg)Follow us](https://instagram.com/... "instagram")`. */
const ICON_ONLY_LINE_RE = /^[*-]\s+\[!\[[^\]]*\]\([^)]+\)[^\]]{0,24}\]\([^)]+\)\s*$/;

/**
 * Jina prepends "follow us" social-icon rows to some sites' markdown, before
 * any real content. Strip a *leading* contiguous run of such lines (blank
 * lines within/after the run are skipped too); stop at the first non-blank
 * line that isn't a match, since real content has started. A no-op when the
 * document doesn't start this way (e.g. Wikipedia) - only ever touches the
 * very start, never images/lists later in the article.
 */
function stripLeadingIconRun(body: string): string {
  const lines = body.split("\n");
  let i = 0;
  let sawMatch = false;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "") {
      i++;
      continue;
    }
    if (ICON_ONLY_LINE_RE.test(line)) {
      sawMatch = true;
      i++;
      continue;
    }
    break;
  }
  return sawMatch ? lines.slice(i).join("\n").replace(/^\s+/, "") : body;
}

function truncateAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut}...`;
}

/** Jina returns `Title: ...\n\nURL Source: ...\n\nMarkdown Content:\n...` - split that apart. */
function parseReaderPayload(raw: string, fallbackUrl: string, limit: number): { title: string; url: string; text: string } {
  const title = /^Title:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? "";
  const url = /^URL Source:\s*(\S+)$/m.exec(raw)?.[1]?.trim() ?? fallbackUrl;
  const marker = raw.indexOf("Markdown Content:");
  const body = marker === -1 ? raw : raw.slice(marker + "Markdown Content:".length);
  const cleaned = stripLeadingIconRun(body.trim());
  return { title, url, text: truncateAtWord(cleaned, limit) };
}

/**
 * Fetch one URL as text through the reader. Shared with the keyless web-search
 * backend (gateway/search/duckduckgo.ts), which reads a results page the same way.
 */
export async function readUrlText(
  url: string,
  signal?: AbortSignal,
  limit: number = MAX_TEXT,
): Promise<{ title: string; url: string; text: string }> {
  const timeout = AbortSignal.timeout(READER_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const res = await providerFetch(
    `${READER_ENDPOINT}${url}`,
    { signal: combined, headers: { Accept: "text/plain" } },
    activeProxyOrUndefined()
  );
  if (!res.ok) throw new Error(`reader failed (${res.status})`);

  const parsed = parseReaderPayload(await res.text(), url, limit);
  if (!parsed.text) throw new Error("reader returned no text");
  return parsed;
}

const READER_HTML_TIMEOUT_MS = 25_000;
/** Safety cap on the fetched DOM snapshot; truncating mid-tag is fine since
 * this is a passive display artifact, not something that needs to parse
 * cleanly - the browser just renders as far as it gets. */
const READER_HTML_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Fetch the fully rendered, post-JS-execution DOM for a URL as plain HTML
 * (Jina's `X-Return-Format: html`, distinct from the markdown mode `readUrlText`
 * uses - this response has no `Title:`/`URL Source:` wrapper, just raw HTML).
 * Used to show a real visual snapshot in the Browser panel's "Rendered" tab.
 */
export async function readUrlHtml(url: string, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(READER_HTML_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const res = await providerFetch(
    `${READER_ENDPOINT}${url}`,
    { signal: combined, headers: { Accept: "text/plain", "X-Return-Format": "html" } },
    activeProxyOrUndefined()
  );
  if (!res.ok) throw new Error(`reader failed (${res.status})`);

  const html = await res.text();
  if (!html.trim()) throw new Error("reader returned no HTML");
  return html.length > READER_HTML_MAX_BYTES ? html.slice(0, READER_HTML_MAX_BYTES) : html;
}

async function readOne(result: SearchResult, index: number, signal?: AbortSignal): Promise<PageExcerpt> {
  const parsed = await readUrlText(result.url, signal);
  return { resultIndex: index, url: parsed.url, title: parsed.title || result.title || "", text: parsed.text };
}

/**
 * Fetch readable text for the top search results so the model can quote exact
 * facts (times, prices, numbers) instead of hedging on search snippets alone.
 * Best-effort: failed reads are silently dropped and the caller falls back to
 * snippet-only context.
 */
export async function readTopResults(
  results: SearchResult[],
  max: number = MAX_READER_PAGES,
  signal?: AbortSignal,
): Promise<PageExcerpt[]> {
  const targets = results
    .slice(0, max)
    .map((r, index) => ({ r, index }))
    .filter(({ r }) => Boolean(r.url));

  const excerpts: PageExcerpt[] = [];
  const queue = [...targets];

  const worker = async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      try {
        excerpts.push(await readOne(next.r, next.index, signal));
      } catch {
        /* best effort - a failed read degrades to snippet-only, never breaks the turn */
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return excerpts.sort((a, b) => a.resultIndex - b.resultIndex);
}
