import { newId } from "./store";

/**
 * Data connectors: a user-configured REST/JSON API an agent can query via the
 * http_request tool (see lib/tools/dataConnectorTools.ts).
 *
 * This is the generalization of "give a data agent a Snowflake connection" -
 * InBrowser has no backend and never will (see CLAUDE.md's serverless
 * constraint), so there is no way to proxy around CORS the way a server-side
 * agent framework would. A connector only ever works against an API that
 * itself sends CORS headers allowing this app's origin; most enterprise
 * databases, including Snowflake's own REST endpoints, do not, and calling
 * one fails with a browser-level CORS error, not a permission error. This is
 * for the APIs that do support it (many public/SaaS JSON APIs do).
 */

export interface DataConnector {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  authHeaderName?: string;
  authHeaderValue?: string;
  createdAt: number;
  updatedAt: number;
}

const KEY = "fachoy:connectors:v1";

export function newDataConnector(partial: Partial<DataConnector> = {}): DataConnector {
  const now = Date.now();
  return {
    id: newId(),
    name: "New connector",
    description: "",
    baseUrl: "",
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

export function loadDataConnectors(): DataConnector[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as DataConnector[];
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function saveDataConnectors(connectors: DataConnector[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(connectors));
  } catch {
    /* ignore */
  }
}
