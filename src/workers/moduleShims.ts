/**
 * Runtime implementations for the specifiers `npmModules.ts` leaves external
 * (`HAND_SHIMMED_SPECIFIERS`) - these need a worker global (`input()`, `fetch`,
 * per-run state) that a generic CDN polyfill can't provide, so they stay
 * hand-written here instead of being resolved through esm.sh like everything
 * else. Shared by typescriptWorker.ts and jsRunnerWorker.ts so the two runners
 * behave identically rather than drifting.
 */

/** Enough of Node's `process` that referencing it doesn't throw a bare ReferenceError. */
export const processShim = { stdin: {}, stdout: {}, argv: [], env: {} };

function makeReadlineShim(promisesApi: boolean, input: (prompt?: string) => string | null) {
  return {
    createInterface: () =>
      promisesApi
        ? {
            question: (query?: string) => Promise.resolve(input(query) ?? ""),
            close: () => {},
          }
        : {
            question: (query: string | undefined, callback: (answer: string) => void) =>
              callback(input(query) ?? ""),
            close: () => {},
          },
  };
}

/**
 * A Node-`fs`-shaped API backed by an in-memory `Map`, reset at the start of
 * every run. Deliberately **not** the agent's persistent OPFS filesystem
 * (`src/lib/vfs/store.ts`, the `fs_read`/`fs_write` tools' backing store) -
 * wiring that in would need a new message-protocol field (which conversation
 * owns this run), a sync OPFS access handle inside a Worker, and concurrency
 * with the tool registry's own fs tools reading/writing the same files. This
 * covers the common "write a temp file, read it back later in the same
 * script" idiom without any of that; a real file on the real filesystem it is
 * not, and scripts that need actual persistence should use `fs_write` instead.
 */
function createFsShim() {
  let files = new Map<string, string | Uint8Array>();

  function normalize(path: string): string {
    return path.replace(/^\.\//, "").replace(/^\//, "");
  }

  function toText(value: string | Uint8Array): string {
    return typeof value === "string" ? value : new TextDecoder().decode(value);
  }

  function wantsText(encoding: unknown): boolean {
    if (typeof encoding === "string") return true;
    if (encoding && typeof encoding === "object" && "encoding" in encoding) {
      return Boolean((encoding as { encoding?: unknown }).encoding);
    }
    return false;
  }

  function readFileSync(path: string, encoding?: unknown): string | Uint8Array {
    const key = normalize(path);
    const value = files.get(key);
    if (value === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
    if (wantsText(encoding)) return toText(value);
    return typeof value === "string" ? new TextEncoder().encode(value) : value;
  }

  function writeFileSync(path: string, data: string | Uint8Array): void {
    files.set(normalize(path), data);
  }

  function appendFileSync(path: string, data: string): void {
    const key = normalize(path);
    const existing = files.get(key);
    files.set(key, existing === undefined ? data : toText(existing) + data);
  }

  function existsSync(path: string): boolean {
    const key = normalize(path);
    if (files.has(key)) return true;
    const prefix = key ? `${key}/` : "";
    return [...files.keys()].some((k) => k.startsWith(prefix));
  }

  function unlinkSync(path: string): void {
    const key = normalize(path);
    if (!files.delete(key)) throw new Error(`ENOENT: no such file, unlink '${path}'`);
  }

  function readdirSync(path: string): string[] {
    const prefix = normalize(path);
    const dir = prefix ? `${prefix}/` : "";
    const names = new Set<string>();
    for (const key of files.keys()) {
      if (!key.startsWith(dir)) continue;
      const rest = key.slice(dir.length);
      names.add(rest.split("/")[0]);
    }
    return [...names];
  }

  function statSync(path: string) {
    const key = normalize(path);
    const isFile = files.has(key);
    return {
      isFile: () => isFile,
      isDirectory: () => !isFile && existsSync(path),
      size: isFile ? toText(files.get(key)!).length : 0,
    };
  }

  const sync = {
    readFileSync,
    writeFileSync,
    appendFileSync,
    existsSync,
    unlinkSync,
    rmSync: unlinkSync,
    readdirSync,
    statSync,
    mkdirSync: () => {}, // directories are implicit here - nothing to create
  };

  const promises = {
    readFile: (path: string, encoding?: unknown) => Promise.resolve(readFileSync(path, encoding)),
    writeFile: (path: string, data: string | Uint8Array) => Promise.resolve(writeFileSync(path, data)),
    appendFile: (path: string, data: string) => Promise.resolve(appendFileSync(path, data)),
    unlink: (path: string) => Promise.resolve(unlinkSync(path)),
    rm: (path: string) => Promise.resolve(unlinkSync(path)),
    readdir: (path: string) => Promise.resolve(readdirSync(path)),
    stat: (path: string) => Promise.resolve(statSync(path)),
    mkdir: () => Promise.resolve(undefined),
  };

  return {
    api: { ...sync, promises },
    promisesApi: promises,
    reset: () => {
      files = new Map();
    },
  };
}

/**
 * A Node-`http`/`https`-shaped `get`/`request` pair backed by `fetch()`,
 * emulating the callback/event shape (`res.statusCode`, `res.on('data'|'end')`,
 * the returned request's `.on('error')`) closely enough for the common idiom -
 * this is what makes a script written against `http.get(url, cb)` run
 * unmodified instead of needing to be rewritten against `fetch()`.
 */
function createHttpShim() {
  type Listener = (arg?: unknown) => void;

  function urlFrom(target: string | Record<string, unknown>): string {
    if (typeof target === "string") return target;
    const protocol = (target.protocol as string) ?? "https:";
    const host = (target.hostname as string) ?? (target.host as string) ?? "localhost";
    const path = (target.path as string) ?? "/";
    return `${protocol}//${host}${path}`;
  }

  function request(
    target: string | Record<string, unknown>,
    optionsOrCallback?: unknown,
    maybeCallback?: (res: unknown) => void
  ) {
    const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback) as
      | ((res: unknown) => void)
      | undefined;
    const url = urlFrom(target);
    const reqListeners: Record<string, Listener[]> = {};
    const req = {
      on(event: string, cb: Listener) {
        (reqListeners[event] ??= []).push(cb);
        return req;
      },
      end() {},
      write() {},
    };

    void fetch(url)
      .then(async (response) => {
        const resListeners: Record<string, Listener[]> = {};
        const res = {
          statusCode: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          on(event: string, cb: Listener) {
            (resListeners[event] ??= []).push(cb);
            return res;
          },
        };
        callback?.(res);
        const reader = response.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            resListeners.data?.forEach((cb) => cb(decoder.decode(value, { stream: true })));
          }
        }
        resListeners.end?.forEach((cb) => cb());
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        reqListeners.error?.forEach((cb) => cb(error));
      });

    return req;
  }

  return {
    get: (target: string | Record<string, unknown>, callback?: (res: unknown) => void) => request(target, callback),
    request,
  };
}

/**
 * Builds one `require()` dispatcher plus a `resetForRun()` to call at the
 * start of every "run" message - the fs shim's contents must not leak between
 * unrelated runs sharing the same warm worker.
 */
export function createModuleShims(input: (prompt?: string) => string | null) {
  const readlineShim = makeReadlineShim(false, input);
  const readlinePromisesShim = makeReadlineShim(true, input);
  const fs = createFsShim();
  const http = createHttpShim();

  function requireShim(specifier: string): unknown {
    switch (specifier) {
      case "readline":
      case "node:readline":
        return readlineShim;
      case "readline/promises":
      case "node:readline/promises":
        return readlinePromisesShim;
      case "process":
      case "node:process":
        return processShim;
      case "fs":
      case "node:fs":
        return fs.api;
      case "fs/promises":
      case "node:fs/promises":
        return fs.promisesApi;
      case "http":
      case "node:http":
      case "https":
      case "node:https":
        return http;
      default:
        // Should not normally be reached - npmModules.ts's plugin already
        // rejects anything else at build time - but a dynamic
        // `require(someVariable)` can still reach here at runtime.
        throw new Error(
          `Cannot import "${specifier}": this sandbox has no npm or Node module resolution for a dynamic require. ` +
            "Use a static import/require so it can be resolved ahead of time."
        );
    }
  }

  return { requireShim, resetForRun: fs.reset };
}
