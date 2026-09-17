/**
 * Live-checks a list of proxies with bounded concurrency, streaming each result
 * out as soon as it settles.
 *
 * The producer/consumer machinery here predates the proxy rework and survived it
 * unchanged; what changed is what a "check" is. It used to be a plain fetch
 * through a CORS-forwarding URL. Now it is a full round trip through the relay,
 * the Worker, the proxy and out to a real endpoint, which is both much slower
 * and much more informative - a pass now means the whole path works and reports
 * the egress IP the provider would actually see.
 *
 * Because a check got slower, the scan gained an early stop. Public lists carry
 * thousands of entries of which the overwhelming majority are dead; at ~12s per
 * check and 8 in flight, working through 500 of them is about twelve minutes and
 * nobody waits for that. `stopAfterAlive` ends the scan once enough working
 * proxies have been found, and the caller offers to keep going.
 */
import type { CustomProxy } from "../types";
import { testProxyConnection, type ProxyTestResult } from "../onniroute";


export type FreeProxyCheckStatus = "alive" | "dead";

export interface FreeProxyCheckResult {
  proxy: CustomProxy;
  status: FreeProxyCheckStatus;
  /** Present when status === "alive". */
  result?: ProxyTestResult;
  /** Present when status === "dead" - the relay's message or the caught error. */
  error?: string;
  /** Present when status === "dead" and the relay's structured response
   *  carried one, e.g. "provider_tls_unverified". */
  code?: string;
}

export interface ScanOptions {
  concurrency?: number;
  /** Stop the scan once this many proxies have passed. 0 means scan everything. */
  stopAfterAlive?: number;
  /** Relay override, so an unsaved Settings draft can be tested. */
  relayUrl?: string;
  /** Unsaved global TLS preference, shared with Settings and normal requests. */
  allowInsecureProxyTls?: boolean;
}

/**
 * A hung proxy must not stall the scan. Generous because a real check is now
 * relay -> Worker -> proxy -> target and a slow-but-working proxy is still worth
 * finding; the old 8s was tuned for a single direct fetch.
 */
const PER_CHECK_TIMEOUT_MS = 12_000;

// The relay's own per-IP rate limit is a fixed 60s window shared across ALL
// relay traffic for this browser's IP (server/src/app.ts's createRateLimiter,
// default 120/min) - not just this scan. Dead proxies (most of any public
// list) fail in ~1-3s, so the worker pool below can otherwise sustain well
// past that budget. MIN_REQUEST_INTERVAL_MS paces new checks (~75/min) well
// under the default so a scan rarely trips it; RATE_LIMIT_BACKOFF_MS is what
// a 429 still gets backed off by when it happens anyway (a lower configured
// limit, or other concurrent relay traffic sharing the bucket) - a full
// window, since the relay's bucket resets every 60s and there's no
// Retry-After header to read instead.
const MIN_REQUEST_INTERVAL_MS = 800;
const RATE_LIMIT_BACKOFF_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** Resolves after `ms`, or immediately if `signal` aborts first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

interface CheckOutcome {
  result: FreeProxyCheckResult;
  /** The real relay HTTP status when the check reached it (0/undefined on a
   *  network error or timeout) - lets the caller tell "our own rate limit"
   *  apart from "this proxy is actually dead" without changing the public
   *  FreeProxyCheckResult shape the UI already renders. */
  httpStatus?: number;
}

async function checkOne(proxy: CustomProxy, relayUrl?: string, allowInsecureProxyTls?: boolean): Promise<CheckOutcome> {
  try {
    const result = await withTimeout(
      testProxyConnection(proxy, relayUrl, allowInsecureProxyTls),
      PER_CHECK_TIMEOUT_MS,
      "Timed out"
    );
    return result.ok
      ? { result: { proxy: result.exitIp ? { ...proxy, exitIp: result.exitIp } : proxy, status: "alive", result }, httpStatus: result.status }
      : {
          result: { proxy, status: "dead", error: result.error ?? `HTTP ${result.status}`, code: result.code },
          httpStatus: result.status,
        };
  } catch (err) {
    return { result: { proxy, status: "dead", error: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * Bounded-concurrency streaming scan: at most `concurrency` checks in flight,
 * yielding each result the moment it settles - in completion order, not
 * submission order - so the caller's `for await` loop can append to UI state
 * incrementally.
 *
 * Cancellation: aborting `signal` stops the generator from starting any new
 * check and from yielding further results almost immediately. It does NOT abort
 * a request already in flight at that instant, but the per-check timeout bounds
 * how long any orphaned one can matter and bounded concurrency caps how many
 * there can ever be.
 */
export async function* checkFreeProxyCandidates(
  proxies: CustomProxy[],
  signal: AbortSignal,
  options: ScanOptions = {}
): AsyncGenerator<FreeProxyCheckResult> {
  const { concurrency = 8, stopAfterAlive = 0, relayUrl, allowInsecureProxyTls } = options;
  if (proxies.length === 0 || signal.aborted) return;

  // Producer/consumer queue: workers push settled results here and `wake()` the
  // generator; the generator drains the queue between waits, which is what makes
  // results stream out as each check completes.
  const queue: FreeProxyCheckResult[] = [];
  let notify: (() => void) | null = null;
  let doneWorkers = 0;
  const totalWorkers = Math.min(concurrency, proxies.length);
  let nextIndex = 0;
  let aliveFound = 0;
  let stopped = false;
  // Shared pacing/backoff state, read and written by every worker - see the
  // MIN_REQUEST_INTERVAL_MS/RATE_LIMIT_BACKOFF_MS comment above checkOne().
  let nextAllowedStart = 0;
  let backoffUntil = 0;

  const wake = () => {
    const n = notify;
    notify = null;
    n?.();
  };
  signal.addEventListener("abort", wake, { once: true });

  // Claims the next allowed request-start slot, waiting out both the global
  // pacing interval and any active rate-limit backoff. The check-then-set is
  // synchronous (no await in between), so concurrent workers can't race each
  // other onto the same slot despite this being shared, mutable state.
  async function reserveSlot(): Promise<void> {
    for (;;) {
      if (signal.aborted || stopped) return;
      const now = Date.now();
      const readyAt = Math.max(nextAllowedStart, backoffUntil);
      if (now >= readyAt) {
        nextAllowedStart = now + MIN_REQUEST_INTERVAL_MS;
        return;
      }
      await sleep(readyAt - now, signal);
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (signal.aborted || stopped) break;
      await reserveSlot();
      if (signal.aborted || stopped) break;
      const index = nextIndex++;
      if (index >= proxies.length) break;
      let outcome = await checkOne(proxies[index], relayUrl, allowInsecureProxyTls);
      if (outcome.httpStatus === 429) {
        // Our own relay's limiter, not this proxy's fault - pause the whole
        // pool (every worker's next reserveSlot() respects backoffUntil too)
        // and give this exact candidate one retry rather than recording it
        // as dead. Retried by this same worker, not requeued for any worker
        // to pick up, so there's no chance of it being dropped if the pool
        // is winding down.
        backoffUntil = Math.max(backoffUntil, Date.now() + RATE_LIMIT_BACKOFF_MS);
        if (signal.aborted || stopped) break;
        await reserveSlot();
        if (signal.aborted || stopped) break;
        outcome = await checkOne(proxies[index], relayUrl, allowInsecureProxyTls);
      }
      const { result } = outcome;
      if (signal.aborted) break;
      if (result.status === "alive") {
        aliveFound++;
        // Set before pushing so in-flight siblings stop claiming new work, but
        // their own results are still delivered below.
        if (stopAfterAlive > 0 && aliveFound >= stopAfterAlive) stopped = true;
      }
      queue.push(result);
      wake();
    }
    doneWorkers++;
    wake();
  }

  const workers = Array.from({ length: totalWorkers }, () => worker());

  try {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (signal.aborted || doneWorkers >= totalWorkers) break;
      await new Promise<void>((res) => {
        notify = res;
      });
    }
  } finally {
    signal.removeEventListener("abort", wake);
    void Promise.allSettled(workers);
  }
}

/** How far a scan got, for the "keep scanning" affordance. */
export function scanExhausted(results: FreeProxyCheckResult[], total: number): boolean {
  return results.length >= total;
}

/**
 * Build an export payload for the finder's Export controls - the same
 * CustomProxy[] shape backup.ts's standalone proxy export/import uses, so
 * files from either source are interchangeable.
 */
export function buildFreeProxyExportPayload(
  results: FreeProxyCheckResult[],
  scope: "all" | "alive" | "dead"
): CustomProxy[] {
  const filtered = scope === "all" ? results : results.filter((r) => r.status === scope);
  return filtered.map(({ proxy }) => ({
    id: proxy.id,
    label: proxy.label,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password,
    enabled: true,
    source: proxy.source,
  }));
}
