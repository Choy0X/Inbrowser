/// <reference lib="webworker" />
import { jspi } from "wasm-feature-detect";
import { loadPHPRuntime, PHP } from "@php-wasm/universal";
// Deep relative imports, not bare "@php-wasm/web-8-5/..." specifiers: that
// package's own package.json "exports" map only permits importing "." - a
// direct file path bypasses that restriction. These two files are patched
// in place by vite.config.ts's patchPhpWasmGluePlugin (see its comment for
// why: @php-wasm/web's own dispatcher is broken under Vite/Rollup in a way
// no plugin hook here could intercept, and pulls in every unused PHP version
// besides). Going straight to @php-wasm/universal's loadPHPRuntime with
// these means @php-wasm/web's all-versions dispatcher is never imported at
// all, so Rollup's build graph never has a reason to discover them.
// @ts-expect-error - no .d.ts ships alongside this file, and TypeScript
// doesn't support `declare module` for relative-path specifiers (only
// package-name-like ones), so this is suppressed rather than fought.
import * as jspiGlue from "../../node_modules/@php-wasm/web-8-5/jspi/php_8_5.js";
// @ts-expect-error - see jspiGlue above.
import * as asyncifyGlue from "../../node_modules/@php-wasm/web-8-5/asyncify/php_8_5.js";
import { installCacheFirstFetch } from "./runtimeCacheFetch";

/** PHP, via WordPress Playground's php-wasm runtime (8.5, self-hosted). */
installCacheFirstFetch("fachoy-plugin-php");

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

let phpPromise: Promise<PHP> | null = null;
async function getPhp(): Promise<PHP> {
  if (!phpPromise) {
    phpPromise = (async () => {
      const glue = (await jspi()) ? jspiGlue : asyncifyGlue;
      const runtimeId = await loadPHPRuntime(glue);
      return new PHP(runtimeId);
    })();
  }
  return phpPromise;
}

self.onmessage = async (event: MessageEvent<InMessage>) => {
  const { kind, runId, code } = event.data;
  if (kind !== "run") return;
  try {
    const php = await getPhp();
    post({ kind: "ready", runId });
    php.writeFile("/run.php", code);
    const response = await php.runStream({ scriptPath: "/run.php" });
    // Passed through verbatim, tags and all: response.stdoutText is the real
    // response body (echo/print/inline HTML), and the caller (the Run
    // button's UI) renders it as actual HTML - stripping php-wasm's own
    // <br/>/<b> fatal-error formatting here would only destroy fidelity a
    // real HTML renderer can just display correctly. Errors still arrive via
    // stdout/"done" here, not a thrown exception: runStream() models an HTTP
    // response, where even a fatal PHP error is just response *content*, not
    // a JS-level failure.
    const stdout = await response.stdoutText;
    const lines = stdout.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // trailing newline artifact
    for (const line of lines) post({ kind: "stdout", runId, line });
    post({ kind: "done", runId });
  } catch (err) {
    post({ kind: "error", runId, message: err instanceof Error ? err.message : String(err) });
  }
};
