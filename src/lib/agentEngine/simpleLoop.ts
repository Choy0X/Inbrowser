import { runAgent, type RunAgentOptions, type AgentRunResult } from "../agentRunner";
import type { EngineEvent } from "./types";

/**
 * Bridges today's callback-based runAgent() into the streaming EngineEvent
 * shape, without touching agentRunner.ts's loop at all - agentRunner.ts
 * already reports every step via onStep, so this only needs to turn that
 * push callback into a pulled async sequence. Zero risk to the existing,
 * working "simple" loop: its behavior is untouched.
 */
export async function* simpleLoop(options: RunAgentOptions): AsyncGenerator<EngineEvent, AgentRunResult> {
  const queue: EngineEvent[] = [];
  let wake: (() => void) | null = null;
  const push = (ev: EngineEvent) => {
    queue.push(ev);
    wake?.();
    wake = null;
  };

  let done = false;
  let result: AgentRunResult | undefined;
  const runPromise = runAgent({
    ...options,
    onStep: (step) => {
      options.onStep?.(step);
      push({ kind: "step", step });
    },
  }).then((r) => {
    result = r;
    done = true;
    wake?.();
    wake = null;
  });

  while (!done || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      continue;
    }
    yield queue.shift()!;
  }
  await runPromise; // surface a thrown error, if runAgent somehow rejected instead of resolving

  if (result!.answer) yield { kind: "answer-final", text: result!.answer };
  yield { kind: "done", result: result! };
  return result!;
}
