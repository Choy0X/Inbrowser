import type { ProviderConnection } from "../types";
import { isChatCapableModelId } from "../capabilities";
import type { ChatMessageInput, ResolvedTarget, ToolDef } from "./types";
import {
  classifyRequest,
  recordOutcome as recordEngineOutcome,
  scoreAndPick,
  selectUsableModels,
  type RoutingCandidate,
} from "./routingEngine";

/**
 * Thin consumer of ./routingEngine — the one classifier engine. This file
 * just adapts ProviderConnection[] into the engine's candidate shape and
 * back; all actual routing intelligence (complexity classification,
 * task fitness, self-healing exclusion, scoring) lives in routingEngine.ts.
 */

function keyFor(alias: string, modelId: string): string {
  return `${alias}/${modelId}`;
}

/** Call after every completed request so future "auto" picks reflect reality.
 *  `hardFailure` (a non-JSON/malformed upstream response) excludes the model
 *  and its connection immediately rather than gradually. `noKeyUsed` marks a
 *  success as proof this model works with no API key at all. `keyRequired`
 *  marks a failure as proof this model needs a key we don't have.
 *  `paymentRequired` marks a failure as proof this model needs a
 *  subscription/balance this connection's key doesn't have, independent of
 *  whether a key is configured at all. `rateLimited` (a 429) also excludes
 *  immediately, cooling down for `retryAfterMs` (the provider's own
 *  Retry-After header) when given, or a conservative fallback otherwise —
 *  see routingEngine.ts's recordOutcome. */
export function recordOutcome(
  alias: string,
  modelId: string,
  ok: boolean,
  latencyMs: number,
  opts?: {
    hardFailure?: boolean;
    noKeyUsed?: boolean;
    keyRequired?: boolean;
    paymentRequired?: boolean;
    rateLimited?: boolean;
    retryAfterMs?: number;
    connectionFailure?: boolean;
  }
): void {
  recordEngineOutcome(keyFor(alias, modelId), ok, latencyMs, opts);
}

/**
 * Score and pick a candidate for "auto", excluding any already-tried keys
 * (for within-turn failover) and classifying the request itself so the
 * pick reflects its complexity/task type, not just health/cost/latency.
 */
export function pickAuto(
  connections: ProviderConnection[],
  excluded: Set<string> = new Set(),
  messages: ChatMessageInput[] = [],
  tools?: ToolDef[],
  systemPrompt?: string,
  previousModel?: string,
  excludedConnections?: Set<string>,
  forceCapable?: boolean,
  maxOutputTokens?: number
): ResolvedTarget | null {
  const byKey = new Map<string, { connection: ProviderConnection; modelId: string }>();
  const candidates: RoutingCandidate[] = [];
  for (const connection of connections) {
    if (!connection.enabled) continue;
    const hasKey = Boolean(connection.apiKey);
    const usable = connection.models.filter((m) => m.enabled !== false && isChatCapableModelId(m.id));
    // A connection with no key configured is restricted to its known-free
    // models only (falling back to trying its full catalog only while none
    // of its models are known free yet, so a brand-new connection can still
    // bootstrap that knowledge) — see selectUsableModels in routingEngine.ts.
    for (const model of selectUsableModels(connection.alias, hasKey, usable)) {
      const key = keyFor(connection.alias, model.id);
      byKey.set(key, { connection, modelId: model.id });
      candidates.push({ ...model, key, modelId: model.id });
    }
  }
  if (candidates.length === 0) return null;

  const profile = classifyRequest(messages, tools, systemPrompt);
  const picked = scoreAndPick(candidates, profile, { excluded, previousKey: previousModel, excludedConnections, forceCapable, maxOutputTokens });
  if (!picked) return null;
  return byKey.get(picked.key) ?? null;
}

/** Resolve a literal "alias/modelId" against the configured connections. */
export function resolveDirect(model: string, connections: ProviderConnection[]): ResolvedTarget | null {
  const slash = model.indexOf("/");
  if (slash === -1) return null;
  const alias = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  const connection = connections.find((c) => c.enabled && c.alias === alias);
  if (!connection) return null;
  return { connection, modelId };
}

/** Resolve a requested model id ("auto" or "alias/modelId") to a concrete target. */
export function resolve(
  model: string,
  connections: ProviderConnection[],
  excluded?: Set<string>,
  messages?: ChatMessageInput[],
  tools?: ToolDef[],
  systemPrompt?: string,
  previousModel?: string,
  excludedConnections?: Set<string>,
  forceCapable?: boolean,
  maxOutputTokens?: number
): ResolvedTarget | null {
  if (model === "auto" || model.startsWith("auto/")) {
    return pickAuto(connections, excluded, messages, tools, systemPrompt, previousModel, excludedConnections, forceCapable, maxOutputTokens);
  }
  return resolveDirect(model, connections);
}

export function excludeKeyFor(target: ResolvedTarget): string {
  return keyFor(target.connection.alias, target.modelId);
}
