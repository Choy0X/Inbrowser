/**
 * Health-based routing across a user's own configured proxy pool. Sibling to
 * autoRoute.ts, but transport-level rather than model-level: a proxy isn't a
 * model or a provider identity, just an alternate path an outbound request
 * can take (see providerFetch.ts). Reuses the same circuit-breaking/cooldown
 * machinery routingEngine.ts already runs for models/connections, in its own
 * store, with a simpler health+latency-only score - task-fitness, tier and
 * context affinity are model concepts that don't apply to a transport hop.
 *
 * The "transport hop" framing turned out to be literally true: when proxies
 * changed from CORS-forwarding URL templates to real host:port endpoints dialled
 * through the relay, nothing in this file needed to change. It reads `p.id`,
 * `p.enabled` and array order, and none of those are properties of a transport.
 */
import type { CustomProxy, ProxyRoutingMode } from "../types";
import {
  createHealthStore,
  getStats,
  healthFactor,
  isCoolingDown,
  recordStoreOutcome,
  recentLatency,
  RATE_LIMIT_FALLBACK_COOLDOWN_MS,
  type HealthStore,
} from "./routingEngine";

const proxyStore: HealthStore = createHealthStore();
const destinationStore: HealthStore = createHealthStore();
const proxyLoad = new Map<string, number>();

export function beginProxyAttempt(proxyId?: string): () => void {
  if (!proxyId) return () => {};
  proxyLoad.set(proxyId, (proxyLoad.get(proxyId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (proxyLoad.get(proxyId) ?? 1) - 1;
    if (remaining > 0) proxyLoad.set(proxyId, remaining); else proxyLoad.delete(proxyId);
  };
}

function destinationKey(proxyId: string, targetUrl: string): string {
  try { return `${proxyId}|${new URL(targetUrl).origin}`; }
  catch { return `${proxyId}|${targetUrl}`; }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

const WEIGHTS = { health: 0.7, latencyInv: 0.3 };
/** Neutral fallback for a proxy with no recorded successes yet. */
const DEFAULT_LATENCY_MS = 2000;

function avgLatencyOf(proxyId: string): number {
  const s = getStats(proxyStore, proxyId);
  return s.successes > 0 ? recentLatency(proxyStore, proxyId) : DEFAULT_LATENCY_MS;
}

/**
 * Pick among eligible routes, respecting global and destination cooldowns.
 * Auto balances recent health, latency and active requests. Manual restricts
 * selection to checked IDs (which act as their enable signal); order/manual
 * preserve array order. No mode retries a route during its cooldown.
 */
export function pickProxy(
  pool: CustomProxy[],
  excluded: Set<string>,
  mode: ProxyRoutingMode = "auto",
  manualProxyIds?: string[],
  targetUrl?: string
): CustomProxy | null {
  let enabled: CustomProxy[];
  if (mode === "manual") {
    const allowed = new Set(manualProxyIds ?? []);
    enabled = pool.filter((p) => allowed.has(p.id) && !excluded.has(p.id));
  } else {
    enabled = pool.filter((p) => p.enabled && !excluded.has(p.id));
  }
  if (enabled.length === 0) return null;

  const candidates = enabled.filter((p) => !isCoolingDown(proxyStore, p.id) &&
    (!targetUrl || !isCoolingDown(destinationStore, destinationKey(p.id, targetUrl))));
  if (!candidates.length) return null;

  if (mode === "order" || mode === "manual") {
    return candidates[0];
  }

  let best: { proxy: CustomProxy; score: number } | null = null;
  for (const p of candidates) {
    const key = targetUrl ? destinationKey(p.id, targetUrl) : undefined;
    const routeSamples = key ? getStats(destinationStore, key).recentOutcomes.length : 0;
    const routeWeight = Math.min(0.7, routeSamples / 5);
    const health = (1 - routeWeight) * healthFactor(proxyStore, p.id) +
      routeWeight * (key ? healthFactor(destinationStore, key) : 0.7);
    const latency = key && getStats(destinationStore, key).successes ? recentLatency(destinationStore, key) : avgLatencyOf(p.id);
    const score =
      WEIGHTS.health * clamp01(health) +
      WEIGHTS.latencyInv * (DEFAULT_LATENCY_MS / (DEFAULT_LATENCY_MS + latency)) -
      Math.min(0.3, (proxyLoad.get(p.id) ?? 0) * 0.08);
    if (!best || score > best.score) best = { proxy: p, score };
  }
  return best!.proxy;
}

/** Call after every attempt made through a proxy, mirroring autoRoute's recordOutcome. */
export function recordProxyOutcome(
  proxyId: string,
  ok: boolean,
  latencyMs: number,
  opts: { hardFailure?: boolean; rateLimited?: boolean; retryAfterMs?: number; targetUrl?: string; targetOnly?: boolean } = {}
): void {
  const cooldownOverrideMs = opts.rateLimited ? opts.retryAfterMs ?? RATE_LIMIT_FALLBACK_COOLDOWN_MS : undefined;
  if (!opts.targetOnly) recordStoreOutcome(proxyStore, proxyId, ok, latencyMs, !!opts.hardFailure, cooldownOverrideMs);
  if (opts.targetUrl) recordStoreOutcome(destinationStore, destinationKey(proxyId, opts.targetUrl), ok, latencyMs, !!opts.hardFailure, cooldownOverrideMs);
}
