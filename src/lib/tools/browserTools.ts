import type { ToolHandler } from "./types";
import { stringArg } from "./types";
import {
  currentPage,
  openPage,
  resolveLink,
  searchUrl,
  type BrowserPage,
} from "./browserSession";

/**
 * "AI browser use": tools that let the model drive a browsing session.
 *
 * These are enabled per-conversation by the user (and per-agent by the agent
 * builder), never on by default - an always-available network-fetch tool is
 * not something to hand a model without the user asking for it.
 */

const SNIPPET_LIMIT = 6000;

function pageSummary(page: BrowserPage, limit = SNIPPET_LIMIT): string {
  const head = `[${page.title || "Untitled"}] ${page.url}`;
  const body = page.text.length > limit ? `${page.text.slice(0, limit)}\n...[truncated]` : page.text;
  const links =
    page.links.length > 0
      ? `\n\nLinks (call browser_follow with a number or link text):\n${page.links
          .slice(0, 25)
          .map((l) => `  ${l.index}. ${l.text} -> ${l.url}`)
          .join("\n")}`
      : "\n\n(no links found on this page)";
  return `${head}\n\n${body}${links}`;
}

const browserOpen: ToolHandler = {
  id: "browser_open",
  group: "browser",
  applies: () => true,
  def: {
    type: "function",
    function: {
      name: "browser_open",
      description:
        "Open a web page and return its readable text plus the links it contains. Works on any public http(s) page. " +
        "Use this to read documentation, articles, or any URL the user mentions.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to open, e.g. 'https://example.com/docs'." },
        },
        required: ["url"],
      },
    },
  },
  async run(args, ctx) {
    const url = stringArg(args, "url");
    if (!url) return "Provide a url to open.";
    try {
      return pageSummary(await openPage(url, ctx.signal));
    } catch (err) {
      return `Could not open ${url}: ${err instanceof Error ? err.message : "unknown error"}`;
    }
  },
};

const browserSearch: ToolHandler = {
  id: "browser_search",
  group: "browser",
  applies: () => true,
  def: {
    type: "function",
    function: {
      name: "browser_search",
      description:
        "Search the web and return the results page, with each result as a numbered link you can follow using browser_follow.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What to search for." } },
        required: ["query"],
      },
    },
  },
  async run(args, ctx) {
    const query = stringArg(args, "query");
    if (!query) return "Provide a search query.";
    try {
      return pageSummary(await openPage(searchUrl(query), ctx.signal), 3000);
    } catch (err) {
      return `Search failed: ${err instanceof Error ? err.message : "unknown error"}`;
    }
  },
};

const browserFollow: ToolHandler = {
  id: "browser_follow",
  group: "browser",
  applies: () => true,
  def: {
    type: "function",
    function: {
      name: "browser_follow",
      description:
        "Follow a link on the currently open page, by its number or by its link text, and return the new page.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "The link number (e.g. '3') or part of its text (e.g. 'Pricing').",
          },
        },
        required: ["target"],
      },
    },
  },
  async run(args, ctx) {
    const target = stringArg(args, "target");
    if (!target) return "Provide a link number or link text to follow.";
    try {
      const link = resolveLink(target);
      return pageSummary(await openPage(link.url, ctx.signal));
    } catch (err) {
      return err instanceof Error ? err.message : "Could not follow that link.";
    }
  },
};

const browserLinks: ToolHandler = {
  id: "browser_links",
  group: "browser",
  applies: () => true,
  def: {
    type: "function",
    function: {
      name: "browser_links",
      description: "List every link on the currently open page, with the numbers browser_follow accepts.",
      parameters: { type: "object", properties: {} },
    },
  },
  async run() {
    try {
      const page = currentPage();
      if (page.links.length === 0) return "This page has no links.";
      return page.links.map((l) => `${l.index}. ${l.text} -> ${l.url}`).join("\n");
    } catch (err) {
      return err instanceof Error ? err.message : "No page open.";
    }
  },
};

const browserFind: ToolHandler = {
  id: "browser_find",
  group: "browser",
  applies: () => true,
  def: {
    type: "function",
    function: {
      name: "browser_find",
      description:
        "Search the text of the currently open page and return the matching passages with surrounding context. " +
        "Use this instead of re-reading a long page.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "The text or phrase to look for." } },
        required: ["text"],
      },
    },
  },
  async run(args) {
    const needle = stringArg(args, "text");
    if (!needle) return "Provide text to look for.";
    try {
      const page = currentPage();
      const haystack = page.text;
      const lower = haystack.toLowerCase();
      const target = needle.toLowerCase();

      const hits: string[] = [];
      let from = 0;
      while (hits.length < 8) {
        const at = lower.indexOf(target, from);
        if (at === -1) break;
        hits.push(haystack.slice(Math.max(0, at - 220), at + target.length + 220).replace(/\s+/g, " ").trim());
        from = at + target.length;
      }
      if (hits.length === 0) return `"${needle}" does not appear on this page (${page.url}).`;
      return hits.map((h, i) => `${i + 1}. ...${h}...`).join("\n\n");
    } catch (err) {
      return err instanceof Error ? err.message : "No page open.";
    }
  },
};

const browserForm: ToolHandler = {
  id: "browser_form",
  group: "browser",
  applies: () => true,
  def: {
    type: "function",
    function: {
      name: "browser_form",
      description:
        "Submit a GET query to a site by appending parameters to a URL, for search boxes and filters. " +
        "Only GET requests are supported; this never submits POST forms or logs in anywhere.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Base URL to submit to, e.g. 'https://example.com/search'." },
          params: {
            type: "object",
            description: "Query parameters as a flat object, e.g. { \"q\": \"widgets\", \"page\": \"2\" }.",
          },
        },
        required: ["url", "params"],
      },
    },
  },
  async run(args, ctx) {
    const base = stringArg(args, "url");
    const params = args.params;
    if (!base) return "Provide a url.";
    if (!params || typeof params !== "object") return "Provide params as an object of query values.";
    try {
      const url = new URL(/^https?:\/\//i.test(base) ? base : `https://${base}`);
      for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
        url.searchParams.set(k, String(v));
      }
      return pageSummary(await openPage(url.toString(), ctx.signal));
    } catch (err) {
      return `Could not submit: ${err instanceof Error ? err.message : "unknown error"}`;
    }
  },
};

export const BROWSER_TOOL_HANDLERS: ToolHandler[] = [
  browserOpen,
  browserSearch,
  browserFollow,
  browserLinks,
  browserFind,
  browserForm,
];
