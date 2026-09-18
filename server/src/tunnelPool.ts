/**
 * Reusing a tunnel across requests.
 *
 * READ THIS BEFORE ENABLING IT. Off unless `poolTunnels` is set, and that
 * default is a judgement, not caution for its own sake. The motivation for
 * pooling was to reduce dials against the Worker's budget, and it barely serves
 * that: a chat turn is one long request with minutes before the next, far past
 * any TTL that is safe here, and the proxy scanner uses a different proxy for
 * every dial by construction, so neither of the two dial-heavy workloads can
 * hit the pool at all. What it does buy is removing a WebSocket handshake, a
 * proxy handshake and a TLS handshake - a few hundred milliseconds - from
 * bursty traffic that revisits the same provider within seconds, which is agent
 * loops and auto-route retry chains. That is real but narrow. Measure the hit
 * rate with scripts/loadtest-relay.ts before deciding it is worth the risk
 * below.
 *
 * THE RISK. Today a tunnel serves exactly one request and is destroyed, so one
 * user's bytes cannot reach another's request. Pooling reintroduces that as a
 * keying bug, and the pooled thing is not just a socket - it is a tunnel, the
 * TLS session inside it and an HTTP agent holding that session. So two
 * independent mechanisms have to fail before a tunnel crosses users:
 *
 *   1. The key includes the requester's own rate-limit bucket, FIRST. Two users
 *      with an identical proxy and target still get different keys.
 *   2. On checkout the full canonical string is compared again, so a hash
 *      collision degrades to a miss rather than to handing out the wrong
 *      tunnel.
 *
 * THE OTHER FAILURE MODE, and the likelier one: an aborted response returned to
 * the pool with unread bytes still in the socket, so the next request parses
 * the tail of the previous reply as its status line. Everything here defaults
 * to NOT pooling - a connection is only offered back after a response that
 * completed cleanly, and anything else is destroyed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import type { RelayProxy } from "./envelope.ts";
import { recordPool } from "./metrics.ts";

export interface PooledConnection {
  /** The tunnel itself. */
  duplex: Duplex;
  /** What HTTP speaks over - the TLS session for an https target, else the tunnel. */
  socket: Duplex;
  /** Bound to this one socket. See the note on maxSockets below. */
  agent: http.Agent;
  /** The exact key material, re-compared on checkout. */
  canonical: string;
  openedAt: number;
  /** Set while a request is using it, so eviction cannot take it mid-flight. */
  inUse: boolean;
  idleTimer?: NodeJS.Timeout;
}

/**
 * Idle TTL.
 *
 * The Worker's own per-tunnel idle cap is 60s, and its timer only resets on
 * actual traffic - between pooled uses there is none, so it runs free. A TTL
 * close to 60s would leave a window where a connection checked out at t=59
 * is killed by the Worker mid-request, which surfaces as a truncated response
 * rather than as an error. 20s leaves 40s of margin, far more than any
 * checkout costs.
 *
 * There is no legal keepalive to hold it open with: every byte after READY is
 * part of the TLS stream, so anything invented here would corrupt it.
 */
const IDLE_TTL_MS = 20_000;

/** 80% of the Worker's 10-minute cap. Retired early rather than dying mid-response. */
const MAX_AGE_MS = 8 * 60 * 1000;

/** 75% of the Worker's 64 MiB cap, counted across every request that used it. */
const MAX_BYTES = 48 * 1024 * 1024;

/** A ceiling on parked connections, so the pool cannot become the leak. */
const MAX_POOLED = 256;

export class TunnelPool {
  private readonly idle = new Map<string, PooledConnection>();
  private readonly keyer: Buffer;

  constructor(secret: string) {
    // Keyed so a pool key is not something an outsider could compute and
    // reason about, and domain-separated from every other use of the secret.
    this.keyer = createHmac("sha256", secret).update("inbrowser-relay-pool-v1").digest();
  }

  /**
   * The identity of a reusable connection.
   *
   * `bucket` comes first and is not optional - it is the structural guarantee
   * that one user's tunnel cannot serve another. The credentials are included
   * so a rotated password yields a fresh tunnel rather than one authenticated
   * with the old one. `allowInsecureTls` and the target host are included
   * because the pooled thing includes a TLS session: `servername` is the
   * target's host, and a request that wants certificates verified must never
   * reuse a session negotiated under a relaxed policy.
   */
  static canonicalise(bucket: string, proxy: RelayProxy, target: { host: string; port: number }): string {
    return JSON.stringify([
      bucket,
      proxy.protocol,
      proxy.host,
      proxy.port,
      proxy.username ?? null,
      proxy.password ?? null,
      Boolean(proxy.allowInsecureTls),
      target.host,
      target.port,
    ]);
  }

  private hash(canonical: string): string {
    return createHmac("sha256", this.keyer).update(canonical).digest("base64url");
  }

  /** A live connection for this exact identity, or null. */
  take(canonical: string): PooledConnection | null {
    const key = this.hash(canonical);
    const entry = this.idle.get(key);
    if (!entry) {
      recordPool("miss", this.idle.size);
      return null;
    }
    this.idle.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);

    // Second mechanism: the hash agreeing is not enough.
    const a = Buffer.from(entry.canonical);
    const b = Buffer.from(canonical);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      destroy(entry);
      recordPool("miss", this.idle.size);
      return null;
    }

    if (!usable(entry)) {
      destroy(entry);
      recordPool("miss", this.idle.size);
      return null;
    }

    entry.inUse = true;
    recordPool("hit", this.idle.size);
    return entry;
  }

  /**
   * Offer a connection back.
   *
   * The caller must only reach here after a response that completed cleanly.
   * Everything else - an abort, an error, a body nobody finished reading -
   * must call `discard`, because a socket with unread bytes handed to the next
   * request is the worst failure this file can produce.
   */
  give(entry: PooledConnection): void {
    entry.inUse = false;
    if (!usable(entry) || this.idle.size >= MAX_POOLED) {
      destroy(entry);
      recordPool("evicted", this.idle.size);
      return;
    }
    const key = this.hash(entry.canonical);
    entry.idleTimer = setTimeout(() => {
      this.idle.delete(key);
      destroy(entry);
      recordPool("evicted", this.idle.size);
    }, IDLE_TTL_MS);
    entry.idleTimer.unref();
    this.idle.set(key, entry);

    // Mark-on-event is the mechanism that actually keeps the pool honest; the
    // checkout guard is only a second line. A connection that dies while
    // parked removes itself here, synchronously, rather than waiting to be
    // discovered.
    const retire = () => {
      if (this.idle.get(key) === entry) {
        this.idle.delete(key);
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        destroy(entry);
        recordPool("evicted", this.idle.size);
      }
    };
    entry.duplex.once("close", retire);
    entry.duplex.once("error", retire);
    entry.duplex.once("end", retire);
  }

  discard(entry: PooledConnection): void {
    entry.inUse = false;
    destroy(entry);
  }

  get size(): number {
    return this.idle.size;
  }

  /** Drops everything. For shutdown and for tests. */
  clear(): void {
    for (const entry of this.idle.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      destroy(entry);
    }
    this.idle.clear();
  }
}

/**
 * Whether a parked connection can still be handed out.
 *
 * `readableEnded` matters as much as `destroyed`: a clean close pushes null and
 * leaves `destroyed` false until something reads, so checking destruction alone
 * would hand out a connection whose peer has already finished.
 */
function usable(entry: PooledConnection): boolean {
  if (entry.duplex.destroyed || entry.duplex.readableEnded || !entry.duplex.writable) return false;
  if (entry.socket !== entry.duplex && (entry.socket.destroyed || !entry.socket.writable)) return false;
  if (Date.now() - entry.openedAt > MAX_AGE_MS) return false;
  if (bytesMoved(entry) > MAX_BYTES) return false;
  return true;
}

/**
 * Bytes this tunnel has carried, across every request that used it.
 *
 * Read off the TLS socket rather than accounted for by hand: it is cumulative
 * by construction, so there is no running total to keep in sync and no way for
 * it to drift. A plain-HTTP target has no such socket and reports 0, which
 * leaves only the age and idle bounds - acceptable, because the byte cap is a
 * margin against the Worker's own 64 MiB limit rather than the primary
 * control, and every target the app actually uses is https.
 */
function bytesMoved(entry: PooledConnection): number {
  const socket = entry.socket as Partial<{ bytesRead: number; bytesWritten: number }>;
  return (socket.bytesRead ?? 0) + (socket.bytesWritten ?? 0);
}

function destroy(entry: PooledConnection): void {
  try {
    entry.agent.destroy();
  } catch {
    /* already gone */
  }
  try {
    entry.duplex.destroy();
  } catch {
    /* already gone */
  }
}

/**
 * The bits of net.Socket that a keep-alive agent calls and a Duplex lacks.
 *
 * Node's Agent is written against real sockets: parking one calls
 * `setKeepAlive`, and handing it back out calls `ref`. On a plain Duplex -
 * which is what an http:// target's tunnel is, since nothing wraps it in TLS -
 * both are undefined, and the agent dies with "socket.setKeepAlive is not a
 * function" the moment a connection is reused. An https:// target happens to
 * work, because a TLSSocket has them, which is exactly the kind of difference
 * that would have shipped unnoticed and then failed on one target shape only.
 *
 * No-ops rather than implementations: every one of these configures a TCP
 * socket we do not have. Liveness for a tunnel comes from the pool's own age
 * and idle bounds, and from the Worker's caps at the far end.
 */
function shimSocketApi(socket: Duplex): void {
  const self = socket as unknown as Record<string, unknown>;
  for (const name of ["setKeepAlive", "setNoDelay", "setTimeout", "ref", "unref"]) {
    if (typeof self[name] !== "function") self[name] = () => socket;
  }
}

/**
 * An agent bound to exactly one socket.
 *
 * One instance per connection, never shared. A shared agent keyed on host:port
 * is how Node normally pools, and it is precisely the wrong thing here: it
 * would pool across users. With `maxSockets: 1` this is a thin keep-alive state
 * machine over a socket we already own, so the agent's own keying never comes
 * into play.
 *
 * `agent: false` remains forbidden in forward.ts for an unrelated and still
 * correct reason - it makes Node build a default agent and ignore
 * createConnection entirely, sending plaintext past the tunnel.
 */
export function bindAgent(socket: Duplex): http.Agent {
  // The same guard workerTunnel.ts needs on its duplex, and for the same
  // reason: this socket outlives any single request now, so an error can
  // arrive when nothing is listening - and an 'error' event with no listener
  // takes the process down. The request's own handler deals with errors that
  // matter; this only ensures one is always attached.
  socket.on("error", () => {});
  shimSocketApi(socket);

  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: 1,
    maxFreeSockets: 1,
    keepAliveMsecs: 1000,
    scheduling: "fifo",
  });
  let used = false;
  (agent as unknown as { createConnection: () => Duplex }).createConnection = () => {
    if (used) {
      // Node asking for a second socket means it thinks this agent can open
      // one, which it cannot - the single socket is the whole contract.
      throw new Error("A pooled tunnel's agent may only ever produce its one socket.");
    }
    used = true;
    return socket;
  };
  return agent;
}
