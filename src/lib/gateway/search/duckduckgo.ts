import type { SearchResult } from "../../types";
import { GatewayError } from "../types";
import { readUrlText } from "../../reader";

/**
 * Keyless web search, reachable from a pure static app.
 *
 * DuckDuckGo has no keyless general-web-search JSON API, and its HTML endpoints
 * send no CORS headers, so the browser cannot read them directly. Every general
 * search API that *does* send CORS headers (Serper, Google CSE, s.jina.ai,
 * Mojeek) requires a key. That leaves one keyless route: fetch DuckDuckGo's
 * lightweight results page through the same CORS-enabled reader used for page
 * content (see lib/reader.ts) and parse the markdown it returns.
 *
 * The request still originates from the user's own browser, so the reader's
 * rate limit is per-user - the same property the whole app is built around.
 *
 * This parses a rendered page rather than a documented API, so it is inherently
 * more fragile than a keyed backend. `searchUnavailable` explains that in the
 * UI, and the keyed backends exist for anyone who wants stability.
 */
const RESULTS_URL = "https://lite.duckduckgo.com/lite/?q=";

/** Reader output is `1.[Title](url)` then snippet lines then a display-url line. */
const ENTRY = /^(\d+)\.\s*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\s*$/;

const MAX_RESULTS = 10;
/** Results pages are long; allow well beyond the per-page default so hits are not cut off. */
const READ_LIMIT = 20_000;

export async function search(
  query: string,
  _apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  let text: string;
  try {
    ({ text } = await readUrlText(`${RESULTS_URL}${encodeURIComponent(query)}`, signal, READ_LIMIT));
  } catch (err) {
    throw new GatewayError(502, err instanceof Error ? err.message : "Web search failed.");
  }

  const results: SearchResult[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
    const match = ENTRY.exec(lines[i].trim());
    if (!match) continue;

    // Everything up to the next numbered entry belongs to this result.
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (ENTRY.test(lines[j].trim())) break;
      block.push(lines[j]);
    }
    // The last line of the block is DuckDuckGo's own display URL, but it can
    // carry a trailing timestamp and occasionally belongs to the neighbouring
    // result, so derive the display URL from the real link instead.
    const body = block.map((l) => l.trim()).filter(Boolean);
    const snippet = (body.length > 1 ? body.slice(0, -1) : body).join(" ").replace(/\*\*/g, "").trim();
    const url = decodeDuckDuckGoRedirect(match[3]);

    results.push({
      title: match[2].trim(),
      url,
      snippet: snippet || undefined,
      displayUrl: displayUrlOf(url),
      position: results.length + 1,
    });
  }

  return results;
}

/** Host + path, as a compact source label under a result. */
function displayUrlOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return undefined;
  }
}

/** DuckDuckGo's result links go through a `//duckduckgo.com/l/?uddg=<encoded>` redirect. */
function decodeDuckDuckGoRedirect(href: string): string {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : href;
  } catch {
    return href;
  }
}
