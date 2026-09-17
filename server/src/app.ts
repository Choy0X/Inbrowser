/**
 * The Fastify instance: hooks, `/health`, and the two API routes.
 *
 * WHAT THIS SERVER IS. It serves the built client and forwards proxied requests
 * to the Cloudflare Worker that dials the user's proxy. Fastify is here to route
 * and serve files, not to be a backend.
 *
 * There are exactly two API routes and the bar for a third is high. `POST
 * /v1/fetch` is the proxy relay, reached only when a user configures a proxy.
 * `GET /v1/suggestions` serves the chat empty state's starter prompts; it is a
 * synchronous read of an in-memory pool that a timer in suggestions.ts refreshes
 * once a day, so it touches no user data, awaits nothing and cannot be made to
 * do work on demand. Anything proposed beyond these two should almost certainly
 * run in the browser instead - see the architecture note in CLAUDE.md.
 *
 * WHAT IT CAN SEE. Everything on the proxied path. It establishes the TLS
 * session with the provider, so requests, responses and provider API keys pass
 * through this process in readable form. That is inherent: whichever component
 * assembles the provider's HTTP request necessarily sees its Authorization
 * header. Since it now also serves the client, it sees ordinary page requests
 * too, the way any web server does.
 *
 * Rules that follow, all load-bearing and three of them asserted by
 * `npm run verify:relay`:
 *
 *   - NEVER LOG A REQUEST FIELD. Not the target, not X-Relay-Meta, not a header.
 *     This is why `logger: false` is set below: Fastify logs every request by
 *     default, and a pino logger would sail straight past the console.* grep in
 *     the verify script while breaking the claim the app makes in
 *     PrivacyPolicyContent.tsx. verify:relay asserts the flag directly.
 *     RELAY_DEBUG_LOG=1 (off by default) opts into a single JSON line per failure
 *     naming which failure site fired plus a duration and a non-identifying
 *     category/code - still never the target, headers, proxy or dial content.
 *   - PERSIST NOTHING on the proxied path. Memory only, for the life of the request.
 *   - NO RESPONSE COMPRESSION OR BUFFERING on the proxied path. Streamed replies
 *     must arrive progressively; a buffering layer turns streaming chat into a
 *     long pause followed by a wall of text.
 *   - DEPENDENCIES ARE ALLOWLISTED. `fastify`, `@fastify/static`, `@fastify/middie`,
 *     pinned exact. verify:relay fails on a fourth.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { EnvelopeError, parseRelayMeta } from "./envelope.ts";
import {
  categorizeForwardError,
  forward,
  FORWARD_ERROR_CODES,
  FORWARD_ERROR_MESSAGES,
  sanitizeResponseHeaders,
} from "./forward.ts";
import { openTunnel, TunnelError } from "./workerTunnel.ts";
import { VERSION, type RelayConfig } from "./config.ts";
import {
  parseDayPart,
  selectSuggestions,
  startSuggestionScheduler,
  type Capability,
} from "./suggestions.ts";

/** Set on every response so the page is cross-origin isolated. */
const ISOLATION_HEADERS: Record<string, string> = {
  // Required for SharedArrayBuffer and Atomics.wait(), which is how interactive
  // Pyodide blocks on input(). COEP is `credentialless` rather than
  // `require-corp` deliberately: require-corp would demand CORP headers from
  // every third-party resource the app loads (providers, jsdelivr wheels, WebLLM
  // weights, r.jina.ai). See the matching note in vite.config.ts.
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

/**
 * Fixed-window counter keyed on client address. Deliberately in-memory: it holds
 * no request content, evaporates on restart, and needs no store. A single
 * process behind one Cloudflare zone is the expected deployment; more than one
 * would need a shared counter, and this function is where that goes.
 */
function createRateLimiter(perMinute: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (now > bucket.resetAt) buckets.delete(key);
  }, 60_000);
  sweep.unref();

  return (key: string): boolean => {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
      return false;
    }
    bucket.count += 1;
    return bucket.count > perMinute;
  };
}

function corsHeaders(config: RelayConfig, origin: string | undefined): Record<string, string> {
  // The client is served from this same origin, so the normal case needs no CORS
  // headers at all. This exists only for a deployment whose client lives
  // elsewhere and points ALLOWED_ORIGINS at it.
  if (config.allowedOrigins.length === 0) return {};
  const allowed = origin && config.allowedOrigins.includes(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-relay-meta",
    // Without this a cross-origin caller can read only the CORS-safelisted
    // headers, and the app's 429 handling reads retry-after - it would silently
    // see null. Same-origin callers can read everything, so this does not arise
    // in the default deployment.
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function buildApp(config: RelayConfig): FastifyInstance {
  // Bun 1.3.14 ignores http.request's custom connection, even with an explicit
  // Agent override. Refuse to run rather than silently send proxy traffic direct.
  if ("bun" in process.versions) {
    throw new Error("The InBrowser relay requires Node.js 22 or newer; Bun does not preserve tunnel routing.");
  }
  const app = Fastify({
    // Asserted by verify:relay. This alone is enough: Fastify then installs
    // abstract-logging's no-ops, so pino is never instantiated, no destination
    // is opened and no request line is ever written. `disableRequestLogging`
    // would be redundant, and its top-level form is deprecated in Fastify 5 and
    // warns on every boot - which would itself break the "this process prints
    // exactly two lines" property.
    logger: false,
    // A streamed reply can idle for a long time between tokens; the real bound
    // is the per-request timeout in forward.ts. Fastify's defaults would cut a
    // slow model off mid-answer.
    requestTimeout: 0,
    connectionTimeout: 0,
    // Fastify's default is 1 MB, which would reject image and audio uploads.
    // Note this is not what actually bounds the relay: the "*" parser below
    // reads nothing, and Fastify enforces bodyLimit inside the parsers that do.
    // The explicit content-length check in handleRelay is the real guard. This
    // is here so any future route is bounded by default.
    bodyLimit: config.maxBodyBytes,
    // Deliberately false. request.ip would then honour X-Forwarded-For, which a
    // client can set freely - and the rate limiter keys on it. cf-connecting-ip
    // is read explicitly below, where the edge is the only thing that can set it.
    trustProxy: false,
  });

  // Both lines matter, and the first is the one that is easy to miss: a "*"
  // parser applies only to content types nothing else has claimed, so without
  // removing the built-ins the JSON parser still buffers and re-encodes every
  // chat request, and the multipart uploads media/openai.ts sends go through a
  // parser at all. Removing them first is what makes the body genuinely
  // untouched - `payload` IS request.raw, handed straight back.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

  app.addHook("onRequest", (request, reply, done) => {
    // A site reachable at both www and non-www serves every page twice under a
    // different URL, which search engines treat as duplicate content and split
    // ranking signals between the two. config.domain (config.json's app.domain)
    // is the canonical, apex form, so the www host is redirected there. The
    // target is always this fixed, configured value - NEVER built from the
    // request's own Host header, which a client fully controls: reflecting it
    // back (even with just a "www." prefix stripped) is an open redirect, and
    // a shared cache keyed on path alone would serve one visitor's forged Host
    // as another's Location. Matching is exact and case-insensitive, so this
    // never fires for an unrelated or spoofed host. This runs first and returns
    // without calling done(): a reply already sent must not fall through to the
    // rest of the hook, or the redirect response would pick up CORS/isolation
    // headers meant for a page that was never served. 301, not 302, so a
    // crawler drops the www URL from its index instead of keeping both alive.
    if (config.domain) {
      const host = request.headers.host?.toLowerCase();
      if (host === `www.${config.domain.toLowerCase()}`) {
        reply
          .code(301)
          .header("Location", `https://${config.domain}${request.raw.url}`)
          .header("Cache-Control", "public, max-age=3600")
          .header("Vary", "Host")
          .send();
        return;
      }
    }

    // fetch() sends no Content-Type when the body is null, and Fastify answers
    // a content-type-less POST with 415 before any handler runs. Proxied GETs
    // are exactly that shape - relayFetch.ts passes `init.body ?? null`, so
    // listModels, the page reader and the proxy Test button all arrive here
    // with no content type and would every one of them 415.
    if (!request.raw.headers["content-type"]) {
      request.raw.headers["content-type"] = "application/octet-stream";
    }

    // Set on reply.raw rather than reply: raw headers survive reply.hijack()
    // (the relay route writes its own head), @fastify/static's send(), and
    // Vite's dev middlewares, which call res.end() directly and never touch
    // Fastify's reply. writeHead(status, obj) merges with these rather than
    // replacing them, so the hijacked path cannot drop them either.
    reply.raw.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    reply.raw.setHeader("Cross-Origin-Embedder-Policy", "credentialless");

    const cors = corsHeaders(config, request.headers.origin);
    for (const [name, value] of Object.entries(cors)) reply.raw.setHeader(name, value);
    done();
  });

  if (config.allowedOrigins.length > 0) {
    app.options("/v1/fetch", async (_request, reply) => reply.code(204).send());
    app.options("/v1/suggestions", async (_request, reply) => reply.code(204).send());
  }

  app.get("/health", async (_request, reply) =>
    reply.header("Cache-Control", "no-store").send({
      ok: true,
      version: VERSION,
      // Boolean only, mirroring inbrowser-relay's own /health - never a
      // preview of the secret itself, on a public unauthenticated endpoint.
      relaySecretConfigured: Boolean(config.relaySecret),
    })
  );

  const rateLimited = createRateLimiter(config.rateLimitPerMinute);

  app.post("/v1/fetch", async (request, reply) => handleRelay(request, reply, config, rateLimited));

  /**
   * Starter prompts for the chat empty state.
   *
   * Reads an in-memory pool and filters it. No await, no model call, and no
   * parameter that could cause one - generation is owned entirely by the timer
   * started below, so this endpoint costs the same whether it is called once or
   * a million times. It cannot fail: the pool is seeded with the curated list at
   * module load, so there is no error branch and no 5xx.
   *
   * The query carries a day part and three capability booleans. That is the
   * whole of it - no identifier, no chat content, no history, not even a date.
   * The day part comes from the browser because only the browser knows the
   * user's local hour.
   */
  app.get("/v1/suggestions", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const caps: Capability[] = [];
    if (query.vision === "1") caps.push("vision");
    if (query.tools === "1") caps.push("tools");
    if (query.reasoning === "1") caps.push("reasoning");

    // The one route here that genuinely should be cached at the edge: the body
    // changes at most once a day and is identical for every visitor sharing a
    // capability set. Everything on the relay path stays no-store - do not copy
    // that header here, and do not copy this one there.
    return reply
      .header("Cache-Control", "public, max-age=900, stale-while-revalidate=86400")
      .send(selectSuggestions({ part: parseDayPart(query.part), caps }));
  });

  startSuggestionScheduler();

  return app;
}

async function handleRelay(
  request: FastifyRequest,
  reply: FastifyReply,
  config: RelayConfig,
  rateLimited: (key: string) => boolean
): Promise<unknown> {
  const origin = request.headers.origin;

  if (config.allowedOrigins.length > 0 && origin && !config.allowedOrigins.includes(origin)) {
    return reply.code(403).send({ error: "Origin not allowed", code: "origin_not_allowed" });
  }

  // Behind Cloudflare, cf-connecting-ip is the real client. Falling back to the
  // socket address would rate-limit every user as one.
  const clientKey = String(
    request.headers["cf-connecting-ip"] ?? request.socket.remoteAddress ?? "unknown"
  );
  if (rateLimited(clientKey)) {
    return reply.code(429).send({ error: "Too many requests. Try again shortly.", code: "rate_limited" });
  }

  if (!config.workerUrl || !config.relaySecret) {
    return reply.code(503).send({ error: "The relay is not configured.", code: "relay_not_configured" });
  }

  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > config.maxBodyBytes) {
    return reply.code(413).send({ error: "Request body is too large.", code: "body_too_large" });
  }

  let meta;
  try {
    meta = parseRelayMeta(request.headers["x-relay-meta"] as string | undefined);
  } catch (err) {
    return reply
      .code(400)
      .send({ error: err instanceof EnvelopeError ? err.message : "Malformed request", code: "malformed_request" });
  }

  const target = new URL(meta.target);
  const targetPort = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;

  // Diagnostic-only, gated by RELAY_DEBUG_LOG (off by default): a random
  // correlation id and per-phase timing, so a failure can be traced to which site
  // produced it without logging any request field (target/headers/proxy/dial).
  const rid = crypto.randomUUID();
  const tunnelStartedAt = Date.now();

  let tunnel;
  try {
    tunnel = await openTunnel({
      workerUrl: config.workerUrl,
      secret: config.relaySecret,
      proxy: meta.proxy,
      target: { host: target.hostname, port: targetPort },
      debugLog: config.debugLog,
      requestId: rid,
    });
  } catch (err) {
    // The Worker's own message reaches the user here: a proxy that answered
    // "407 rejected these credentials" says exactly that in Settings.
    const message = err instanceof TunnelError ? err.message : "Could not open a tunnel to the proxy.";
    const code = err instanceof TunnelError ? err.publicCode : "tunnel_open_failed";
    if (config.debugLog) {
      console.error(
        JSON.stringify({ evt: "relay_failure", site: "tunnel_open", rid, durationMs: Date.now() - tunnelStartedAt, message })
      );
    }
    // Cloudflare replaces origin 502/504 bodies with its own error page on
    // non-Enterprise plans. Use 503 for our own failures so the browser receives
    // the actionable JSON code. Real provider statuses are still mirrored below.
    return reply.header("Cache-Control", "no-store").code(503).send({ error: message, code });
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  // The content-type parser above handed back the untouched stream.
  const body = hasBody ? (request.body as NodeJS.ReadableStream | null) : null;

  const forwardStartedAt = Date.now();

  try {
    const result = await forward({ meta, tunnel, body, allowInsecureTls: meta.proxy.allowInsecureTls });

    // Hijacked rather than reply.send(stream): this path mirrors an arbitrary
    // upstream status and header set and must not have Fastify re-frame it. A
    // regression here looks like "streaming chat became a long pause", which is
    // exactly the failure worth being conservative about.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(result.status, {
      ...ISOLATION_HEADERS,
      ...corsHeaders(config, origin),
      ...sanitizeResponseHeaders(result.headers),
      "Cache-Control": "no-store",
    });

    result.body.pipe(raw);
    result.body.on("error", () => raw.destroy());
    raw.on("close", () => {
      (result.body as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      tunnel.destroy();
    });
    return reply;
  } catch (err) {
    tunnel.destroy();
    if (reply.sent || reply.raw.headersSent) {
      reply.raw.destroy();
      return reply;
    }
    // A post-READY tunnel failure (idle timeout, cap exceeded, the Worker
    // closing mid-stream) surfaces here as a TunnelError, not only from the
    // tunnel-open site above - its message is already fixed/generic, safe to
    // send as-is. Anything else is a genuine Node/TLS error from forward()
    // itself: never send its raw message, since a TLS altname-mismatch
    // error's message embeds the target hostname in plain text - route it
    // through the same fixed, category-based message/code used for logging.
    let message: string;
    let code: string;
    if (err instanceof TunnelError) {
      message = err.message;
      code = err.publicCode;
    } else {
      const { category, code: nodeErrCode } = categorizeForwardError(err);
      message = FORWARD_ERROR_MESSAGES[category];
      code = FORWARD_ERROR_CODES[category];
      if (config.debugLog) {
        console.error(
          JSON.stringify({
            evt: "relay_failure",
            site: "forward",
            rid,
            durationMs: Date.now() - forwardStartedAt,
            category,
            code: nodeErrCode,
          })
        );
      }
    }
    // Same edge-safe status as a tunnel-open failure; see the catch above.
    return reply.header("Cache-Control", "no-store").code(503).send({ error: message, code });
  }
}
