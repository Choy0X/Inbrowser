import type { CustomProxy, SearchResult } from "../../types";
import { providerFetch } from "../providerFetch";
import { GatewayError } from "../types";
import { extractError } from "../util";

/**
 * Serper (google.serper.dev) - Google results behind a free-tier key.
 *
 * Chosen over Brave and SerpAPI because it is one of the few search APIs that
 * actually sends `Access-Control-Allow-Origin: *`, so a static app can call it
 * from the browser. Brave, SerpAPI, Tavily, Exa and public SearXNG instances
 * send no CORS headers at all and were removed for that reason.
 */
export async function search(
  query: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
  proxy?: CustomProxy,
): Promise<SearchResult[]> {
  if (!apiKey) throw new GatewayError(401, "Serper requires an API key (Settings > Search).");
  const res = await providerFetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query }),
    signal,
  }, proxy);
  const data = (await res.json().catch(() => ({}))) as {
    organic?: { title: string; link: string; snippet?: string; position?: number; date?: string }[];
  };
  if (!res.ok) throw new GatewayError(res.status, extractError(data) || `Serper HTTP ${res.status}`);
  return (data.organic ?? []).map((r, i) => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet,
    position: r.position ?? i + 1,
    publishedAt: r.date ?? null,
  }));
}
