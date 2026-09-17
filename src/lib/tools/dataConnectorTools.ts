import type { ToolHandler } from "./types";
import { stringArg } from "./types";
import { loadDataConnectors } from "../dataConnectors";

const OUTPUT_LIMIT = 8000;

/**
 * Generic HTTP/JSON access to a user-configured data connector. Bound by the
 * same hard CORS reality as every other network call in this app (see
 * dataConnectors.ts's own doc comment) - this is not a proxy and never will
 * be one.
 */
const httpRequest: ToolHandler = {
  id: "http_request",
  group: "web",
  applies: () => loadDataConnectors().length > 0,
  get def() {
    const connectors = loadDataConnectors();
    const list = connectors.length > 0
      ? connectors.map((c) => `"${c.name}" (${c.description || c.baseUrl})`).join("; ")
      : "(none configured)";
    return {
      type: "function" as const,
      function: {
        name: "http_request",
        description:
          `Call a user-configured data connector's REST/JSON API. Available connectors: ${list}. ` +
          "This only reaches APIs that send CORS headers allowing this app's origin - most enterprise " +
          "databases and internal APIs, including Snowflake's own REST endpoints, do not, and this will " +
          "fail with a network/CORS error rather than a permission error. Only GET and POST are supported.",
        parameters: {
          type: "object",
          properties: {
            connector: { type: "string", description: "Name of the connector to use." },
            path: { type: "string", description: "Path appended to the connector's base URL, e.g. '/v1/items'." },
            method: { type: "string", description: "GET or POST. Defaults to GET." },
            body: { type: "string", description: "JSON request body, for POST." },
          },
          required: ["connector", "path"],
        },
      },
    };
  },
  async run(args, ctx) {
    const connectors = loadDataConnectors();
    const wanted = stringArg(args, "connector").toLowerCase();
    const connector = connectors.find((c) => c.name.toLowerCase() === wanted)
      ?? connectors.find((c) => c.name.toLowerCase().includes(wanted));
    if (!connector) {
      return `No such connector "${wanted}". Available: ${connectors.map((c) => c.name).join(", ") || "(none configured)"}.`;
    }
    if (!connector.baseUrl) return `Connector "${connector.name}" has no base URL configured.`;

    const path = stringArg(args, "path");
    const method = (stringArg(args, "method") || "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") return "Only GET and POST are supported.";
    const body = typeof args.body === "string" ? args.body : undefined;

    const url = connector.baseUrl.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (connector.authHeaderName && connector.authHeaderValue) {
      headers[connector.authHeaderName] = connector.authHeaderValue;
    }
    if (method === "POST" && body !== undefined) headers["Content-Type"] = "application/json";

    try {
      const res = await fetch(url, { method, headers, body: method === "POST" ? body : undefined, signal: ctx.signal });
      const text = await res.text();
      const truncated = text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n...(truncated)` : text;
      return `${res.status} ${res.statusText}\n${truncated}`;
    } catch (err) {
      return `Request failed: ${err instanceof Error ? err.message : String(err)}. If this is a CORS error, the API does not allow requests from this app's origin and cannot be reached from the browser.`;
    }
  },
};

export const DATA_CONNECTOR_TOOL_HANDLERS: ToolHandler[] = [httpRequest];
