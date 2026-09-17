import type { ToolHandler } from "./types";
import { stringArg } from "./types";
import { webSearch } from "../onniroute";
import type { SearchResult } from "../types";

/**
 * Real structured web search, via whatever backend the user has configured
 * for the chat search toggle (Settings > Search: keyless DuckDuckGo, or a
 * keyed Serper/Jina backend) - reusing onniroute.ts's webSearch() exactly,
 * not reimplementing backend selection here.
 *
 * browser_search (browserTools.ts) stays as-is for "open a results page and
 * click through it"; this is for "get me clean structured hits" - numbered,
 * with real snippets, no DOM/HTML scraping regex involved.
 */

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results.";
  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title}`, `   ${r.url}`];
      if (r.snippet) lines.push(`   ${r.snippet}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

const webSearchTool: ToolHandler = {
  id: "web_search",
  group: "web",
  applies: () => true,
  def: {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web and get back structured results (title, URL, snippet) ranked by relevance. " +
        "For reading a specific page's full content or following its links, use browser_open/browser_follow instead.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
        },
        required: ["query"],
      },
    },
  },
  async run(args, ctx) {
    const query = stringArg(args, "query");
    if (!query) return "Provide a search query.";
    try {
      const result = await webSearch(query, ctx.signal);
      if (result.error) return `Search failed: ${result.error}`;
      return formatResults(result.results);
    } catch (err) {
      return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const WEB_TOOL_HANDLERS: ToolHandler[] = [webSearchTool];
