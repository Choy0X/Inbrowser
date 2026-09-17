# The InBrowser server

One Fastify process doing two jobs: it serves the built client from `dist/`, and
it forwards proxied requests to the Cloudflare Worker that dials the user's proxy
(that Worker lives in its own repository, `inbrowser-relay`).

Serving both from one origin is the point. It removes CORS and the `X-Relay-Meta`
preflight, removes the relay URL the client would otherwise have to be told, and
puts the cross-origin-isolation headers in one place instead of several that can
drift.

The relay route is only reached when a user configures a proxy. With none
configured, the browser still calls providers directly and this process is only
a web server.

## What it can see

**Everything on the proxied path.** It establishes the TLS session with the
provider, so requests, responses and provider API keys pass through this process
in readable form. Since it also serves the client, it sees ordinary page requests
the way any web server does.

That is inherent rather than a shortcut: whichever component assembles the
provider's HTTP request necessarily sees its `Authorization` header, and no
arrangement between our own components changes it. Encrypting the hop to the
Worker protects the hop; it cannot hide plaintext from the machine that produced
it. The app states this plainly in `src/components/PrivacyPolicyContent.tsx`
rather than implying end-to-end secrecy.

What follows are rules, not preferences. `npm run verify:relay` asserts the first
and last of them.

- **Never log a request field.** No access log with the target, no dump of
  `X-Relay-Meta`, no error log carrying a header or URL. The only thing written to
  stdout is the listening line.
- **Persist nothing.** No disk, no database, no cache. Memory only, for the life
  of the request.
- **Dependencies are an allowlist, not an accident.** `fastify`,
  `@fastify/static` and `@fastify/middie`, pinned exact; `verify:relay` fails on a
  fourth or on an unpinned range. This replaced a real guarantee - the relay used
  to import nothing outside `node:*` - so what protects the hot path now is
  structural instead: `/v1/fetch` hijacks the reply, and no parser, serializer,
  hook or logger reads the body, the credentials in `X-Relay-Meta`, or the
  response stream.
- **Fastify's logger stays off.** It logs every request by default, and a pino
  logger is invisible to a `console.*` grep. `verify:relay` asserts `logger: false`.
- **No compression or buffering middleware.** Streamed replies must arrive
  progressively; a buffering layer turns streaming chat into a long pause followed
  by a wall of text.
- **Never disable certificate verification.** A hostile proxy is on the path, and
  certificate checking is exactly what defends against it.

## Why the design is this small

Because TLS is terminated here rather than at the edge, Node's own stack does the
work:

```
tunnel (Duplex over WebSocket)
  -> tls.connect({ socket: tunnel })      inner TLS, to the provider
  -> http.request({ createConnection })   HTTP/1.1 over that
```

Note `http.request`, not `https.request`, even for an `https://` target - the
socket already speaks TLS. The consequence is that **there is no hand-written HTTP
parser anywhere in this project**: no status-line parsing, no chunked decoding, no
trailer handling.

It is also why HTTPS proxies work. The outer TLS (to the proxy) is the Worker's
`connect({ secureTransport: "on" })`, the inner TLS (to the provider) is
`tls.connect` here. Two layers in two runtimes - workerd's `startTls()` is
one-shot and cannot nest them, and nothing here asks it to.

## Keeping in sync with the worker repo

`src/protocol.ts` and `src/crypto.ts` have counterparts in the worker repo. They
were byte-identical twins checked by a file comparison until the worker moved
out; across a repository boundary that is impossible, so the wire format is
pinned by `src/conformance.ts` instead - a frozen sealed dial frame that both
repositories assert they can open with their own key derivation.

If that assertion fails, the two repositories disagree about the wire format. Do
not regenerate the vector to make it pass; find which side changed. A change made
deliberately on both sides is a protocol revision and should bump
`PROTOCOL_VERSION`, which `decodeDialFrame` rejects on mismatch so a
half-upgraded deployment fails loudly rather than behaving strangely.

## Run it

Everything is driven from the repo root - the server is part of the root package
now, and `process.cwd()` must be the repo root either way (vite.config.ts's
plugins resolve against it too).

Settings live in **`config.json`** at the repo root, under its `server` section -
one file for the whole app, client and server. Every key there is overridable by
the environment variable named beside it, and the environment wins.

```bash
npm install
npm run build          # typecheck, client -> dist/, server -> server/dist/relay.cjs

# config.json already points workerUrl at the deployed worker, so in practice
# the secret is the only thing you must supply. Set it here rather than in the
# file: config.json is committed, so a secret written into it is public, and the
# server refuses to proxy with a placeholder.
export RELAY_SECRET="<the same value the worker was deployed with>"
npm start
```

The secret is not generated per deployment - it must **match** the one already
set on the worker (`wrangler secret put RELAY_SECRET` in the inbrowser-relay
repo). A mismatch is not silent: the worker refuses the dial and the user sees
"The relay could not authenticate this request."

Point `WORKER_URL` elsewhere only to use a worker you deployed yourself. It must
use the `wss://` scheme and end in `/v1` - that is the only path the worker
accepts a tunnel on; `/health` is for the Settings test button and everything
else 404s.

Deploying needs `dist/`, `server/dist/relay.cjs`, **`config.json`** and Node 22+
- **no `node_modules` on the host**, because the server bundle
is self-contained. On a Debian VPS, `../install.sh` does all of this including
Caddy, the firewall and a sandboxed systemd unit.
`config.json` is read at runtime, so changing a `server` value needs a restart
but not a rebuild.

Run from the repo root: `process.cwd()` is where both `config.json` and the
default `dist/` are resolved from.

It is bundled to **CJS, deliberately**. Fastify's dependency tree does dynamic
`require()`s that esbuild's ESM output cannot satisfy (`avvio` alone fails with
"Dynamic require of node:events is not supported"), and CJS has `require`,
`__dirname` and `__filename` natively, so the whole class of failure disappears
rather than being worked around. The consequence is that nothing in `server/src`
may use top-level `await` or `import.meta.url`.

Requires **Node 22+** for the global `WebSocket`. Development runs the TypeScript
directly via Node's type stripping, which is why every import in `server/src`
carries an explicit `.ts` extension and why none of it may use non-erasable
syntax such as constructor parameter properties.

**Do not run the relay under Bun.** Bun 1.3.14 ignores the custom connection
required by `http.request`, sending requests directly instead of through the
tunnel. The server refuses to start under Bun. Bun may still install packages
and build the app; the systemd `ExecStart` must use a real Node 22+ binary.
On Node, `agent: false` also overrides `createConnection`; leave the agent option
unset. `verify:relay` tests a distinct direct-connection trap and HTTPS over the
tunnel so a successful direct request cannot mask this regression.

Generate the secret once with `openssl rand -hex 32` and give the same value to
both halves. Without it, this returns 503 on every request and the Worker refuses
every dial.

**Deploy behind Cloudflare with proxied DNS.** That hides this host's address from
the public internet as well as from configured proxies, which is the same property
the Worker provides on the egress side.

## API

| Route | Purpose |
|---|---|
| `GET /health` | `{ok, version}`. Used by the Test relay button in Settings. |
| `POST /v1/fetch` | The proxied request. Everything descriptive is in the `X-Relay-Meta` header (base64url JSON: target, method, headers, proxy); the body streams through untouched. |
| `GET /*` | The built client, with Range and 304 support and cross-origin-isolation headers on every response. Unknown paths fall back to `index.html` - **except** `/v1/`, `/health` and the runtime-asset prefixes, which 404. A missing engine asset answered with HTML reaches the runtime as a wasm module and throws a `CompileError` starting `<!do`, which is a genuinely hard failure to trace. |

`X-Relay-Meta` is a header rather than query parameters because the payload
carries the user's proxy credentials, and query strings get written to request
logs, browser history and anything in between. One header also keeps the CORS
preflight to `content-type, x-relay-meta`.

The response mirrors the provider's status and headers, so the browser's own
`fetch` yields a correct `Response` with a streaming body and nothing has to be
synthesized on the client.

Failures generated by the relay itself use HTTP **503**,
`Cache-Control: no-store`, and `{error: string, code: string}`. Keep this distinct
from a provider response: the provider's own status and body are still mirrored.
Cloudflare's default error-page handling can replace origin 502/504 bodies,
discarding our actionable JSON, while 503 is exempt. Origin Error Page Pass-thru
is Enterprise-only; see [Cloudflare Custom Errors](https://developers.cloudflare.com/rules/custom-errors/).
`RELAY_DEBUG_LOG=1` emits non-identifying `relay_failure` events with a `site`
of `tunnel_open` or `forward` (previously named `relay_502`).

When diagnosing a bare Cloudflare error, correlate its `CF-RAY` with the origin
access log before concluding the origin was unreachable. A 502 error page can
replace an otherwise valid JSON response. Preserve the Caddy log filter that
deletes `request>headers>X-Relay-Meta`; that header contains proxy credentials.

## Limits

| Setting | Default | Env |
|---|---|---|
| Rate limit | 120 req/min per client | `RATE_LIMIT_PER_MINUTE` |
| Max body | 32 MiB | `MAX_BODY_BYTES` |
| Provider timeout | 120 s | - |

The rate limiter is an in-memory fixed window, which is right for a single process
behind one Cloudflare zone. Running more than one process would need a shared
counter; `rateLimited()` in `src/index.ts` is where that goes.
