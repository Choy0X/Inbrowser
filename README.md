<div align="center">
  <img src="public/icon-192.png" width="88" height="88" alt="InBrowser logo">
  <h1>InBrowser</h1>
  <p><strong>The whole AI stack, in one browser tab.</strong></p>
  <p>No account. No API key. No server.</p>
  <p>
    <a href="https://inbrowser.tech"><strong>inbrowser.tech</strong></a>
    &nbsp;&middot;&nbsp;
    <a href="#quick-start">Quick start</a>
    &nbsp;&middot;&nbsp;
    <a href="#self-hosting">Self-hosting</a>
    &nbsp;&middot;&nbsp;
    <a href="#faq">FAQ</a>
  </p>
</div>

---

**InBrowser is a free, open-source AI chat app that runs entirely in your browser.** Open the
page and start typing: no signup, no API key, no install. Large language models run locally on
your GPU through WebGPU, twelve programming-language runtimes execute real code inside the tab
via WebAssembly, and autonomous agents work through tasks on their own. Every conversation,
skill, memory and model weight stays in your own browser profile, because there is no backend to
send them to.

It is served by a small Node/Bun server carrying two endpoints. One is an optional proxy relay,
only ever contacted if you configure a proxy yourself. The other serves the starter prompts on
the empty chat screen, which refresh once a day; it receives whether it is morning or evening
where you are and what your selected model can do, and nothing else.

## Contents

- [What it does](#what-it-does)
- [Run an LLM in your browser](#run-an-llm-in-your-browser)
- [Run real code in the tab](#run-real-code-in-the-tab)
- [Agents and skills](#agents-and-skills)
- [Why there is no backend](#why-there-is-no-backend)
- [Privacy and the optional proxy relay](#privacy-and-the-optional-proxy-relay)
- [Quick start](#quick-start)
- [Self-hosting](#self-hosting)
- [Development](#development)
- [Browser support](#browser-support)
- [FAQ](#faq)
- [License](#license)

## What it does

| | |
|---|---|
| **Chat with no signup and no API key** | Twelve provider presets ship in Settings: ten hosted, most of them usable with no key at all, plus local models and Chrome's built-in AI. Every keyless preset is checked against the live provider before it ships. |
| **Run models on your own GPU** | 163 models through [WebLLM](https://github.com/mlc-ai/web-llm) on WebGPU, plus Chrome's built-in Gemini Nano. Once the weights are cached, a local model needs no key, no quota and no network. |
| **Execute real code** | Python, JavaScript, TypeScript, C, C++, PHP, Ruby, R, Lua, Clojure, SQLite and a WASI shell, all compiled to WebAssembly and running in the tab, with interactive `input()`. |
| **Build autonomous agents** | A bounded plan-act-observe loop with step caps, token budgets and a full step trace. Agents delegate to sub-agents, fan out as a parallel swarm, and keep a persistent workspace. |
| **Install skills** | Agent Skills (`.skill`) packages, installable from any GitHub repository publishing the standard marketplace manifest. Nothing installs unread: the full `SKILL.md` is shown first. |
| **Search, read, generate** | Web search with page reading, document parsing, image generation and editing, video generation, audio transcription. |
| **Automate** | Scheduled prompts that run on a repeating schedule while the tab is open, with full result history. |
| **Remember** | Durable facts carried across conversations, each one queued for your approval before it is saved. |
| **Work offline** | An installable PWA. After the first load the app shell works with no network; a downloaded local model works with no network at all. |
| **Back up and move** | Chats, skills, memories and tasks export as a single zip and re-import elsewhere, merging by ID. Provider API keys are deliberately never included. |

## Run an LLM in your browser

Local inference is the part most people arrive for. Install a model once from the Store and it
runs on your own hardware from then on:

- **163 open models** from the WebLLM catalog, from sub-1B up to roughly 8B parameters, which is
  the practical ceiling of what a browser can address.
- **Weights are cached** in Cache Storage after the first download, so the cost is paid once.
- **No key, no quota, no rate limit**, because there is no service on the other end.
- **Works with the network off** once the model is cached.
- **Chrome's built-in Gemini Nano** needs no download at all, if your Chrome exposes it.

Installed local models appear in the normal model picker alongside hosted ones and inherit the
same routing, failover and capability detection.

> **Requires WebGPU.** See [browser support](#browser-support). If the app reports that WebGPU is
> unavailable, that is your browser or GPU, not the app.

## Run real code in the tab

Twelve runtimes, each compiled to WebAssembly and installed on demand from the Store. The
assistant can execute code in any installed runtime and read back the real result, sandboxed with
a timeout, rather than describing what the code would do.

| Runtime | Engine | Notes |
|---|---|---|
| Python | Pyodide | The scientific stack, in the tab |
| JavaScript / TypeScript | Worker-backed | |
| C / C++ | Real Clang/LLVM compiled to WebAssembly | Compiles and links in the browser with `wasm-ld`; `#include <gmp.h>` works, via a bundled mini-gmp |
| PHP | php-wasm | |
| Ruby | ruby.wasm | |
| R | webR | |
| Lua | wasmoon | |
| Clojure | Scittle | |
| SQLite | sql.js | |
| Shell | WASI | |

Alongside them are eleven utility tool plugins the model can call directly rather than
approximating: regex, text diff and statistics, JSON, CSV, hashing and encoding, ID generation,
JWT decoding, colour and contrast, dates, and unit conversion.

> **Self-hosting note:** the C/C++ toolchain ships `clang.wasm`, a single 42.5 MB file, which
> exceeds the per-file limit on some static hosts (Cloudflare Pages caps at 25 MB). Serving the
> build from a real origin rather than a static host avoids this. See [self-hosting](#self-hosting).

## Agents and skills

An agent is a system prompt, a model policy, a toolset and a bounded loop. Every run has a step
cap, a token budget and an abort signal, and **every stopping reason is reported** rather than
hidden, because an autonomous loop that only shows its conclusion cannot be trusted or debugged.

Agents can delegate to other agents through a depth-capped call tool with a shared scratchpad,
which is how a researcher to writer to critic chain works, or fan work out to several members in
parallel in swarm mode with a per-member trace you can drill into.

Skills are reusable instruction packages in the standard Agent Skills format. Activating one
injects its instructions and enables a bounded two-tool loop so the assistant can read the
skill's own bundled files as it works.

## Why there is no backend

This is not about hosting cost. The free providers InBrowser uses rate-limit **per IP**. Any
shared hop, whether a relay, a CORS proxy or a serverless function, would put every user behind
a single IP, so a handful of requests would exhaust the quota and block everyone at once. Calling
providers straight from the browser makes every rate limit per-user.

Two rules follow, and both are load-bearing:

1. **No shared network hop for provider traffic.** Not for any provider, ever.
2. **A provider must send CORS headers to ship.** If its real chat response carries no
   `Access-Control-Allow-Origin`, the browser cannot read it, so the provider is dropped rather
   than proxied. Two providers were removed for exactly this reason.

You can verify this yourself: open DevTools, go to the Network tab, and confirm that no provider,
search or model-weight request targets InBrowser's own origin. What you will see from this origin
is the app's own files, `/v1/suggestions` for the empty screen's starter prompts, and `/v1/fetch`
if you have configured a proxy.

The starter prompts are the one deliberate exception to the rule above, and they are built so it
does not become a hole in it. The server generates them **once a day for everybody**, on its own
timer, and every request just reads the result out of memory - so the per-IP argument does not
apply: it is one call a day in total, not one per user. No parameter can make it generate, so
traffic cannot become spend, and the providers it generates from are keyless, so there is no API
key on that path to leak. Deployers who want none of it can set `client.suggestionsEnabled` to
`false` in `config.json`.

### Automatic model and proxy routing

Auto balances task suitability, recent reliability, response speed and active requests. It checks
known image and tool support and estimates the full request's context needs, including tool
definitions and output headroom. Unknown catalog metadata lowers confidence; it is never treated
as proof of compatibility.

Selection learns from recent outcomes and time to first token. Old health observations fade,
active requests spread load, and provider cooldowns respect `Retry-After`. Proxy Auto tracks
success per destination independently: a broken connection can try another proxy, while a
provider's authentication or rate-limit response does not mark a working proxy unhealthy.
Cancelled requests do not affect health, and a partial answer never restarts on a different
route. Manual model choices and proxy list order stay user-controlled.

Capability and quality estimates are heuristics, not measured answer-quality benchmarks, and
routing statistics live in memory for the current tab only.

## Privacy and the optional proxy relay

Conversations live in IndexedDB, settings and API keys in localStorage, agent workspaces in OPFS,
and model weights in Cache Storage. All of it stays in your browser profile.

One feature does not fit the no-backend rule, and it is opt-in. If you configure a real proxy in
Settings, InBrowser cannot dial it from the page, because browsers do not speak HTTP CONNECT or
SOCKS. Those requests go through a relay instead:

```
browser -> relay (server/) -> Cloudflare Worker -> your proxy -> provider
```

This is the opposite of a shared hop rather than an example of one: the address the provider sees
is *the proxy you chose*, which moves you off the shared pool instead of onto it. The Worker
exists because whatever dials a proxy reveals its IP to whoever runs that proxy, and you can
point InBrowser at a proxy you control yourself. It is maintained separately, in
[**inbrowser-relay**](https://github.com/Choy0X/inbrowser-relay).

The two halves see very different things, and it is worth being exact:

- The **Worker** sees nothing readable. Your proxy's address and credentials are AES-256-GCM
  sealed before they reach it, and the rest is the encrypted connection to the provider.
- The **relay** does see your requests, including API keys, because it is what establishes that
  connection on your behalf. Whichever machine builds the request necessarily sees what is in it.
  It keeps no logs and writes nothing to disk, and the
  relay address is a setting, so you can point it at one you run yourself.

With no proxy configured, none of this is contacted and nothing changes.

Settings > Proxies also has **Allow unverified connections for all proxies**, off by default.
Unverified connections can expose API keys and messages to proxy operators; enable it only if you
trust every proxy you use.

## Quick start

```bash
git clone https://github.com/Choy0X/Inbrowser.git
cd Inbrowser
npm install
npm run dev        # app + relay on http://localhost:5173, one process
```

`npm run dev` runs the same server as production with Vite mounted inside it, so dev and
production route identically: a path that works in one cannot 404 in the other. Server edits
restart the process; client edits hot-reload.

## Self-hosting

```bash
npm run build      # typecheck, client build to dist/, server bundle
npm start          # the built app on http://localhost:4173
```

Deploying is `dist/`, `server/dist/relay.cjs`, `config.json` and a runtime. The server bundle is
self-contained, so there is no `node_modules` on the host. It runs under **Node 22+ or Bun**.

Everything configurable lives in one file, **`config.json`** at the repo root: brand strings, a
few client defaults, and the server's settings including the relay secret. Its `server` section
is never compiled into the browser bundle, and every key there can be overridden by an
environment variable, which is how to set the real secret, since the file itself is committed.

### Deployment notes

The app is a static `dist/` plus a single-file server, so any setup that can serve one and run
the other will work. Two things are worth knowing before you size it:

**Put a CDN in front.** `dist/` is **311 MB**, most of it WebAssembly language runtimes, and
without an edge cache every cold visitor pulls all of it from your origin. If you use Cloudflare,
note that it does not cache `.wasm`, `.tar` or `.pch` by default, so those need an explicit cache
rule. Fronting the origin also keeps its address out of the open.

**Run the server as an unprivileged service.** It terminates TLS to providers when a user has
configured a proxy, so it should be sandboxed like anything else handling credentials: its own
user, no write access outside its own directory, and a reverse proxy terminating public TLS in
front of it.

## Development

```bash
npm run dev               # app + relay on one port, Vite in middleware mode
npm run build             # typecheck, client build, server bundle
npm run typecheck:server  # the server half on its own
npm start                 # serve the build
```

The stack is React 18, TypeScript, Vite 6 and Tailwind on the client, and Fastify on the server
with a deliberately short dependency allowlist, since that process terminates TLS to providers.
Routes are pre-rendered to static HTML at build time, so every URL serves real content to
crawlers and to anything that does not execute JavaScript.

`npm run build` typechecks both halves before it emits anything, so a type error fails the build
rather than shipping.

## Browser support

| | Local models (WebGPU) | Everything else |
|---|---|---|
| Chrome / Edge 113+ | Yes | Yes |
| Firefox 141+ (Windows) | Yes | Yes |
| Safari 26+ | Yes | Yes |
| Older browsers | No | Yes |

Hosted providers, code runtimes, agents and skills work in any modern browser. Only local model
inference needs WebGPU.

## FAQ

**Is it really free?**
Yes, and there is no paid tier. The hosted providers it ships with are free services with their
own rate limits; local models have no limits at all because nothing is being called.

**Do I need an API key?**
No. You can add your own keys for providers that need them, and they stay in your browser, but
the app is usable without any.

**Does my data leave my browser?**
Your conversations, files and settings do not. Provider requests obviously reach the provider you
chose, called directly from your browser. The one exception is the opt-in proxy relay described
[above](#privacy-and-the-optional-proxy-relay), which the privacy policy states plainly.

**How big is the model download?**
It depends on the model. The catalog spans roughly 300 MB to several GB, shown per model in the
Store before you install. It is a one-time cost per model.

**Can it work completely offline?**
Yes, once the app shell is installed as a PWA and at least one local model is cached.

**How does this compare to Ollama or LM Studio?**
Those are desktop applications and will run larger models faster, because they are not bound by
what a browser can address. InBrowser needs no install and no admin rights, runs on a locked-down
or managed device, and puts code execution, agents and skills in the same tab as the model.

**Can I self-host it?**
Yes, for yourself. Note the license below before hosting a public instance.

## License

See [LICENSE](./LICENSE): free to clone, use and modify with attribution to **Choy0X**;
publishing or hosting a public instance is reserved to the author.

Bundled third-party components keep their own licenses, notably a GPL-2.0 `busybox.wasm` binary
and several GPL/LGPL npm packages used by the PHP and filesystem runtimes. See LICENSE for
details.

---

<div align="center">
  <sub>
    Built by <a href="https://github.com/Choy0X">Choy0X</a> &middot;
    <a href="https://inbrowser.tech">inbrowser.tech</a> &middot;
    Proxy egress Worker: <a href="https://github.com/Choy0X/inbrowser-relay">inbrowser-relay</a>
  </sub>
</div>
