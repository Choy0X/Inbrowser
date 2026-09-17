import type { CustomProxy, SearchResult } from "../../types";
import { providerFetch } from "../providerFetch";
import { GatewayError } from "../types";

/**
 * Jina search (s.jina.ai) - web search whose results already come back as
 * readable page content, with CORS headers, behind a free key from jina.ai.
 *
 * Because each result carries its own extracted text, the reader pass in
 * lib/reader.ts has little left to do when this backend is selected.
 */
export async function search(
  query: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
  proxy?: CustomProxy,
): Promise<SearchResult[]> {
  if (!apiKey) throw new GatewayError(401, "Jina search requires a free API key (Settings > Search).");
  const res = await providerFetch(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal,
  }, proxy);
  const data = (await res.json().catch(() => ({}))) as {
    data?: { title?: string; url?: string; description?: string; content?: string; date?: string }[];
  };
  if (!res.ok) throw new GatewayError(res.status, `Jina search HTTP ${res.status}`);
  return (data.data ?? [])
    .filter((r) => Boolean(r.url))
    .map((r, i) => ({
      title: r.title ?? r.url ?? "",
      url: r.url as string,
      snippet: r.description,
      content: r.content,
      position: i + 1,
      publishedAt: r.date ?? null,
    }));
}
