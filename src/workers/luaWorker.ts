import { LuaFactory } from "wasmoon";
import { requestInputSync } from "../lib/codeRunners/interactiveStdin";

/**
 * Lua 5.4, via wasmoon.
 *
 * A fresh state per run, with `print` and `io.write` redirected to the console
 * pane. The engine is created once and kept warm; only the state is rebuilt,
 * which is what makes repeated runs cheap without leaking globals between them.
 */

type InMessage =
  | { kind: "run"; runId: string; code: string; interactive?: boolean; buffer?: SharedArrayBuffer }
  | { kind: "input-answer"; runId: string; value: string | null };
type OutMessage =
  | { kind: "ready"; runId: string }
  | { kind: "stdout" | "stderr"; runId: string; line: string }
  | { kind: "done"; runId: string }
  | { kind: "error"; runId: string; message: string }
  | { kind: "input-request"; runId: string; prompt: string };

function post(msg: OutMessage): void {
  (self as unknown as Worker).postMessage(msg);
}

const factory = new LuaFactory();

/**
 * Redefines `io.read` (and adds a plain `input` global) to call the JS
 * `fachoy_input` function bound below. wasmoon can bridge Promise-returning
 * JS globals into Lua on its own, but this sandbox uses the same synchronous
 * Atomics.wait protocol every other in-thread runtime here uses (see
 * interactiveStdin.ts) so `io.read`'s normal blocking-call semantics hold
 * exactly as they do in real Lua, not just for a bolted-on `input()` name.
 * Only the "*l"/"*line" (default) format is meaningfully interactive; "*n"
 * best-effort parses the answered line as a number, "*a" returns it as-is.
 */
const INPUT_PRELUDE_LUA = `
function input(prompt)
  return fachoy_input(prompt)
end
io.read = function(fmt)
  local line = fachoy_input(nil)
  if line == nil then return nil end
  if fmt == "*n" or fmt == "n" then return tonumber(line) end
  return line
end
`;

self.onmessage = async (event: MessageEvent<InMessage>) => {
  if (event.data.kind !== "run") return;
  const { runId, code, interactive, buffer } = event.data;

  let lua: Awaited<ReturnType<typeof factory.createEngine>> | null = null;
  try {
    lua = await factory.createEngine();
    post({ kind: "ready", runId });

    // Lua's print takes varargs and tab-separates them; keep that behaviour.
    lua.global.set("print", (...args: unknown[]) => {
      post({ kind: "stdout", runId, line: args.map((a) => String(a)).join("\t") });
    });

    const inputBuffer = interactive ? buffer : undefined;
    lua.global.set("fachoy_input", (prompt?: string) => {
      if (!inputBuffer) return null;
      post({ kind: "input-request", runId, prompt: prompt ?? "" });
      try {
        return requestInputSync(inputBuffer);
      } catch (err) {
        post({
          kind: "stderr",
          runId,
          line: `[interactive input] reading the answer failed (${err instanceof Error ? err.message : String(err)}); treating as EOF.`,
        });
        return null;
      }
    });
    await lua.doString(INPUT_PRELUDE_LUA);

    await lua.doString(code);
    post({ kind: "done", runId });
  } catch (err) {
    post({ kind: "error", runId, message: err instanceof Error ? err.message : String(err) });
  } finally {
    lua?.global.close();
  }
};
