/// <reference lib="webworker" />
import { DefaultRubyVM } from "@ruby/wasm-wasi/dist/browser";
import { installCacheFirstFetch } from "./runtimeCacheFetch";

/**
 * Ruby, via ruby.wasm (the official CRuby build compiled to WebAssembly by
 * the Ruby core team). Unlike php-wasm, nothing here fights Vite: this
 * package has no problematic import of its own .wasm binary - the caller
 * fetches and compiles it directly, so self-hosting is just a normal fetch
 * against this app's own origin (see RUNTIME_ASSET_CONFIGS).
 */
installCacheFirstFetch("fachoy-plugin-ruby");

export {};

type InMessage = { kind: "run"; runId: string; code: string };
type OutMessage =
  | { kind: "ready"; runId: string }
  | { kind: "stdout" | "stderr"; runId: string; line: string }
  | { kind: "done"; runId: string }
  | { kind: "error"; runId: string; message: string };

function post(msg: OutMessage): void {
  (self as unknown as Worker).postMessage(msg);
}

/**
 * DefaultRubyVM's `consolePrint: true` default (kept as-is) routes WASI
 * stdout/stderr through console.log/console.warn - overridden here the same
 * way clojureWorker.ts handles scittle's output, reading the *current* run's
 * id rather than closing over the one active when the VM booted.
 */
let currentRunId = "";

// consolePrinter (see @ruby/wasm-wasi's console.js) calls back with each raw
// WASI fd_write chunk verbatim, newline included - stripped here so lines
// match the trailing-newline-free convention every other worker's protocol
// already uses.
const nativeLog = console.log.bind(console);
function post_line(kind: "stdout" | "stderr", raw: string) {
  const line = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (currentRunId) post({ kind, runId: currentRunId, line });
}
console.log = (...args: unknown[]) => {
  if (!currentRunId) return nativeLog(...args);
  post_line("stdout", args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
};
console.warn = (...args: unknown[]) => {
  if (!currentRunId) return;
  post_line("stderr", args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
};

type RubyVM = Awaited<ReturnType<typeof DefaultRubyVM>>["vm"];
let vmPromise: Promise<RubyVM> | null = null;
async function getVm(): Promise<RubyVM> {
  if (!vmPromise) {
    vmPromise = (async () => {
      const response = await fetch("/ruby/ruby+stdlib.wasm");
      const module = await WebAssembly.compileStreaming(response);
      const { vm } = await DefaultRubyVM(module);
      return vm;
    })();
  }
  return vmPromise;
}

self.onmessage = async (event: MessageEvent<InMessage>) => {
  const { kind, runId, code } = event.data;
  if (kind !== "run") return;
  currentRunId = runId;
  try {
    const vm = await getVm();
    post({ kind: "ready", runId });
    await vm.evalAsync(code);
    post({ kind: "done", runId });
  } catch (err) {
    post({ kind: "error", runId, message: err instanceof Error ? err.message : String(err) });
  }
};
