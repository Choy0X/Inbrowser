/**
 * Aggregate counters for the proxied path.
 *
 * WHY THIS IS NOT A LOG. PrivacyPolicyContent says this component "keeps no
 * logs, writes nothing to disk, and holds a request only for as long as it
 * takes to forward it", and that claim has to survive this file. What is
 * recorded here is a set of integers: how many tunnels are open, how many
 * closed, how many requests were rejected under each of the error codes the
 * relay already sends to the browser. No target, no header, no proxy, no
 * address, nothing that distinguishes one request from another. Nothing is
 * written to disk and nothing survives a restart.
 *
 * The property is enforced by the type system rather than by discipline:
 * `recordRejection` takes a `MetricCode`, a closed union built from the error
 * constants that already exist elsewhere in this directory. There is no
 * overload taking a string, and no counter carries a free-form label - so a
 * request field cannot become a dimension here without someone first widening
 * that union, which is a visible edit to this file rather than an accident at
 * a call site. verify-relay.ts asserts both halves: that every code passed at
 * a call site is in the union, and that a live scrape of a real request's
 * metrics contains none of that request's content.
 *
 * WHERE IT IS SERVED. Not on the Fastify app. A separate listener on
 * 127.0.0.1, off unless METRICS_PORT is set - see startMetricsServer below for
 * why that is the right shape rather than a third route.
 */
// Type-only, and that matters: forward.ts and workerTunnel.ts both record into
// this module, so a runtime import either way round would be a cycle. `import
// type` is erased entirely, leaving the union below derived from those
// constants with no import edge at all at runtime.
import type { FORWARD_ERROR_CODES } from "./forward.ts";
import type { TUNNEL_ERROR_CODES } from "./workerTunnel.ts";
import { readdirSync } from "node:fs";

/**
 * Every value that may be used as a counter label.
 *
 * Deliberately assembled from the existing `code` constants rather than
 * written out fresh, so a new error code cannot be added to the relay and
 * silently go uncounted - and, more importantly, so this list can never drift
 * into containing something request-derived.
 */
export type MetricCode =
  | (typeof FORWARD_ERROR_CODES)[keyof typeof FORWARD_ERROR_CODES]
  | (typeof TUNNEL_ERROR_CODES)[keyof typeof TUNNEL_ERROR_CODES]
  // Rejections handleRelay makes before a tunnel is ever opened.
  | "origin_not_allowed"
  | "rate_limited"
  | "relay_not_configured"
  | "body_too_large"
  | "malformed_request"
  | "relay_at_capacity"
  // Post-READY tunnel failures, mirroring protocol.ts's RELAY_CLOSE_CODE_NAMES.
  | "dial_rejected"
  | "proxy_unreachable"
  | "handshake_failed"
  | "worker_rate_limited"
  | "target_not_allowed"
  | "upstream_closed"
  | "idle_timeout"
  | "cap_exceeded"
  | "dial_decrypt_failed"
  | "relay_closed"
  | "closed_normally"
  | "tunnel_open_failed"
  | "tunnel_stalled";

/**
 * Latency buckets, in milliseconds, as cumulative upper bounds.
 *
 * Chosen against the timeout ladder this system already has rather than picked
 * for roundness: a tunnel open is expected in the low hundreds of ms, the
 * Worker's own pre-READY worst case is 25s, and openTunnel gives up at 35s. The
 * top finite bucket sits above the former and below the latter, so "slow but
 * succeeded" and "gave up" stay distinguishable.
 */
const LATENCY_BUCKETS_MS = [50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600] as const;

/** A fixed-bucket histogram. Counts only - no sample is retained. */
interface Histogram {
  /** One counter per bucket, plus a final +Inf bucket. */
  counts: Uint32Array;
  sum: number;
  total: number;
}

function newHistogram(): Histogram {
  return { counts: new Uint32Array(LATENCY_BUCKETS_MS.length + 1), sum: 0, total: 0 };
}

function observe(h: Histogram, valueMs: number): void {
  if (!Number.isFinite(valueMs) || valueMs < 0) return;
  let i = 0;
  while (i < LATENCY_BUCKETS_MS.length && valueMs > LATENCY_BUCKETS_MS[i]) i++;
  h.counts[i]++;
  h.sum += valueMs;
  h.total++;
}

/**
 * The whole of what this module holds. Plain numbers, one object, no history -
 * which is what makes "nothing is retained about any individual request" a
 * structural fact rather than a promise.
 */
export interface MetricsSnapshot {
  tunnelsInflight: number;
  tunnelsOpenTotal: number;
  tunnelsClosedTotal: number;
  rejections: Partial<Record<MetricCode, number>>;
  openLatency: { counts: number[]; sum: number; total: number };
  ttfb: { counts: number[]; sum: number; total: number };
  bytesUpTotal: number;
  bytesDownTotal: number;
  stallsTotal: number;
  poolHitsTotal: number;
  poolMissesTotal: number;
  poolEvictedTotal: number;
  poolSize: number;
}

const state = {
  tunnelsInflight: 0,
  tunnelsOpenTotal: 0,
  tunnelsClosedTotal: 0,
  rejections: new Map<MetricCode, number>(),
  openLatency: newHistogram(),
  ttfb: newHistogram(),
  bytesUpTotal: 0,
  bytesDownTotal: 0,
  stallsTotal: 0,
  poolHitsTotal: 0,
  poolMissesTotal: 0,
  poolEvictedTotal: 0,
  poolSize: 0,
};

export function recordRejection(code: MetricCode): void {
  state.rejections.set(code, (state.rejections.get(code) ?? 0) + 1);
}

/** A tunnel became usable. `latencyMs` is the whole open, including the dial. */
export function recordTunnelOpen(latencyMs: number): void {
  state.tunnelsOpenTotal++;
  state.tunnelsInflight++;
  observe(state.openLatency, latencyMs);
}

/**
 * A tunnel went away, for any reason at all.
 *
 * Must be called exactly once per recordTunnelOpen. The in-flight gauge is the
 * single most useful number here and a drift in it is invisible until capacity
 * silently disappears, so the load test asserts it returns to zero.
 */
export function recordTunnelClose(): void {
  state.tunnelsClosedTotal++;
  if (state.tunnelsInflight > 0) state.tunnelsInflight--;
}

export function recordTtfb(ms: number): void {
  observe(state.ttfb, ms);
}

export function recordBytes(up: number, down: number): void {
  state.bytesUpTotal += up;
  state.bytesDownTotal += down;
}

export function recordStall(): void {
  state.stallsTotal++;
}

export function recordPool(event: "hit" | "miss" | "evicted", size: number): void {
  if (event === "hit") state.poolHitsTotal++;
  else if (event === "miss") state.poolMissesTotal++;
  else state.poolEvictedTotal++;
  state.poolSize = size;
}

export function snapshot(): MetricsSnapshot {
  const rejections: Partial<Record<MetricCode, number>> = {};
  for (const [code, n] of state.rejections) rejections[code] = n;
  return {
    tunnelsInflight: state.tunnelsInflight,
    tunnelsOpenTotal: state.tunnelsOpenTotal,
    tunnelsClosedTotal: state.tunnelsClosedTotal,
    rejections,
    openLatency: {
      counts: Array.from(state.openLatency.counts),
      sum: state.openLatency.sum,
      total: state.openLatency.total,
    },
    ttfb: { counts: Array.from(state.ttfb.counts), sum: state.ttfb.sum, total: state.ttfb.total },
    bytesUpTotal: state.bytesUpTotal,
    bytesDownTotal: state.bytesDownTotal,
    stallsTotal: state.stallsTotal,
    poolHitsTotal: state.poolHitsTotal,
    poolMissesTotal: state.poolMissesTotal,
    poolEvictedTotal: state.poolEvictedTotal,
    poolSize: state.poolSize,
  };
}

/** Test-only. Lets one process run several scenarios without restarting. */
export function resetMetrics(): void {
  state.tunnelsInflight = 0;
  state.tunnelsOpenTotal = 0;
  state.tunnelsClosedTotal = 0;
  state.rejections.clear();
  state.openLatency = newHistogram();
  state.ttfb = newHistogram();
  state.bytesUpTotal = 0;
  state.bytesDownTotal = 0;
  state.stallsTotal = 0;
  state.poolHitsTotal = 0;
  state.poolMissesTotal = 0;
  state.poolEvictedTotal = 0;
  state.poolSize = 0;
}

/** Adds `b` into `a`, for summing cluster workers in the primary. */
export function mergeSnapshots(a: MetricsSnapshot, b: MetricsSnapshot): MetricsSnapshot {
  const rejections: Partial<Record<MetricCode, number>> = { ...a.rejections };
  for (const [code, n] of Object.entries(b.rejections) as [MetricCode, number][]) {
    rejections[code] = (rejections[code] ?? 0) + n;
  }
  const mergeHist = (x: MetricsSnapshot["openLatency"], y: MetricsSnapshot["openLatency"]) => ({
    counts: x.counts.map((n, i) => n + (y.counts[i] ?? 0)),
    sum: x.sum + y.sum,
    total: x.total + y.total,
  });
  return {
    tunnelsInflight: a.tunnelsInflight + b.tunnelsInflight,
    tunnelsOpenTotal: a.tunnelsOpenTotal + b.tunnelsOpenTotal,
    tunnelsClosedTotal: a.tunnelsClosedTotal + b.tunnelsClosedTotal,
    rejections,
    openLatency: mergeHist(a.openLatency, b.openLatency),
    ttfb: mergeHist(a.ttfb, b.ttfb),
    bytesUpTotal: a.bytesUpTotal + b.bytesUpTotal,
    bytesDownTotal: a.bytesDownTotal + b.bytesDownTotal,
    stallsTotal: a.stallsTotal + b.stallsTotal,
    poolHitsTotal: a.poolHitsTotal + b.poolHitsTotal,
    poolMissesTotal: a.poolMissesTotal + b.poolMissesTotal,
    poolEvictedTotal: a.poolEvictedTotal + b.poolEvictedTotal,
    poolSize: a.poolSize + b.poolSize,
  };
}

export function emptySnapshot(): MetricsSnapshot {
  const zeros = { counts: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0), sum: 0, total: 0 };
  return {
    tunnelsInflight: 0,
    tunnelsOpenTotal: 0,
    tunnelsClosedTotal: 0,
    rejections: {},
    openLatency: { ...zeros, counts: [...zeros.counts] },
    ttfb: { ...zeros, counts: [...zeros.counts] },
    bytesUpTotal: 0,
    bytesDownTotal: 0,
    stallsTotal: 0,
    poolHitsTotal: 0,
    poolMissesTotal: 0,
    poolEvictedTotal: 0,
    poolSize: 0,
  };
}

/**
 * Descriptors that are cheap to read but pointless to keep a running count of.
 * Sampled at scrape time rather than maintained, so nothing is spent on them
 * when nobody is scraping.
 *
 * ProtectSystem=strict in the systemd unit does not cover /proc/self, so this
 * works under the deployed hardening - but it is in a try/catch anyway, since
 * the whole endpoint failing because a descriptor count was unavailable would
 * be a poor trade.
 */
function openFileDescriptors(): number | null {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    // No /proc - Windows, macOS, a container without it mounted. A missing
    // descriptor count must not take the whole endpoint down with it.
    return null;
  }
}

/** Prometheus text exposition. Hand-rolled - see the note in the module header. */
export function renderPrometheus(snap: MetricsSnapshot, extra: { workers: number }): string {
  const out: string[] = [];
  const line = (name: string, value: number, help: string, type: "counter" | "gauge") => {
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} ${type}`);
    out.push(`${name} ${value}`);
  };

  line("relay_tunnels_inflight", snap.tunnelsInflight, "Tunnels currently open.", "gauge");
  line("relay_tunnels_open_total", snap.tunnelsOpenTotal, "Tunnels opened since start.", "counter");
  line("relay_tunnels_closed_total", snap.tunnelsClosedTotal, "Tunnels closed since start.", "counter");
  line("relay_stalls_total", snap.stallsTotal, "Tunnels dropped for exceeding the stall deadline.", "counter");
  line("relay_bytes_up_total", snap.bytesUpTotal, "Bytes sent toward the provider.", "counter");
  line("relay_bytes_down_total", snap.bytesDownTotal, "Bytes received from the provider.", "counter");
  line("relay_pool_hits_total", snap.poolHitsTotal, "Requests served by a pooled tunnel.", "counter");
  line("relay_pool_misses_total", snap.poolMissesTotal, "Requests that had to open a tunnel.", "counter");
  line("relay_pool_evicted_total", snap.poolEvictedTotal, "Pooled tunnels retired before reuse.", "counter");
  line("relay_pool_size", snap.poolSize, "Tunnels currently parked in the pool.", "gauge");
  line("relay_cluster_workers", extra.workers, "Cluster workers reporting.", "gauge");
  line("relay_uptime_seconds", Math.round(process.uptime()), "Process uptime.", "gauge");

  const mem = process.memoryUsage();
  line("relay_rss_bytes", mem.rss, "Resident set size.", "gauge");
  line("relay_heap_used_bytes", mem.heapUsed, "V8 heap in use.", "gauge");

  const fds = openFileDescriptors();
  if (fds !== null) line("relay_open_fds", fds, "Open file descriptors.", "gauge");

  out.push("# HELP relay_rejections_total Requests refused, by the code sent to the client.");
  out.push("# TYPE relay_rejections_total counter");
  for (const [code, n] of Object.entries(snap.rejections)) {
    out.push(`relay_rejections_total{code="${code}"} ${n}`);
  }

  for (const [name, hist, help] of [
    ["relay_open_latency_ms", snap.openLatency, "Time to open a tunnel."],
    ["relay_ttfb_ms", snap.ttfb, "Time from request to the provider's first byte."],
  ] as const) {
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} histogram`);
    let cumulative = 0;
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
      cumulative += hist.counts[i] ?? 0;
      out.push(`${name}_bucket{le="${LATENCY_BUCKETS_MS[i]}"} ${cumulative}`);
    }
    cumulative += hist.counts[LATENCY_BUCKETS_MS.length] ?? 0;
    out.push(`${name}_bucket{le="+Inf"} ${cumulative}`);
    out.push(`${name}_sum ${hist.sum}`);
    out.push(`${name}_count ${hist.total}`);
  }

  return out.join("\n") + "\n";
}
