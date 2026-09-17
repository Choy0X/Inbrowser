import { chatStream, type ChatMessageInput } from "../onniroute";
import type { ToolCallWire } from "../gateway/types";
import { runTool, toolById, toolDefs, type ToolContext } from "../tools/registry";
import type { ToolHandler } from "../tools/types";
import {
  skillContext,
  callAgentTool,
  approxTokens,
  type RunAgentOptions,
  type AgentRunResult,
  type AgentStep,
} from "../agentRunner";
import { newId } from "../store";
import type { EngineEvent, RunMode, Workspace, WorkspaceContextEntry } from "./types";

/**
 * The Query -> Plan -> Execute -> Report state machine.
 *
 * Query: one no-tool call deciding "answer this directly" vs "needs work".
 * Plan ("PM"): one no-tool call writing an ordered plan into the shared
 * Workspace context - this *is* the "PM reads/writes the shared context"
 * link; no separate channel is needed since every mode reads the same
 * workspace.context before it starts.
 * Execute: today's tool-calling round loop, writing results into context.
 * Report: a final no-tool call synthesizing everything into the answer.
 *
 * v1 scope: Execute only ever advances to Report (on zero tool calls, or on
 * hitting maxSteps - which now still produces a best-effort answer instead
 * of a bare stop). A model-triggered Execute -> Plan re-entry (e.g. a
 * `revise_plan` tool) and the opt-in concurrent answer-drafting mode
 * (Agent.workflow.streamAnswerDuringExecution) are deliberately not wired up
 * yet - the mode-change events and maxModeTransitions cap this file already
 * emits/enforces are exactly what that re-entry would use once it exists.
 */
export async function* workflowLoop(options: RunAgentOptions): AsyncGenerator<EngineEvent, AgentRunResult> {
  const { agent, input, skills, signal } = options;
  const depth = options.depth ?? 0;
  const maxModeTransitions = agent.workflow?.maxModeTransitions ?? 20;

  const steps: AgentStep[] = [];
  let stepIndex = 0;
  let used = 0;
  const emit = (step: Omit<AgentStep, "index" | "depth" | "agentName">): void => {
    const full: AgentStep = { ...step, index: stepIndex++, depth, agentName: agent.name };
    steps.push(full);
    options.onStep?.(full);
  };

  const handlers: ToolHandler[] = agent.toolIds
    .map((id) => toolById(id))
    .filter((h): h is ToolHandler => Boolean(h));
  const delegate = callAgentTool(options, depth);
  if (delegate) handlers.push(delegate);

  const ctx: ToolContext = { convoId: `agent:${agent.id}`, signal, activeSkills: new Map(), skills };

  const workspace: Workspace = {
    tools: handlers,
    question: input,
    context: [],
    scratch: options.scratchpad ?? new Map(),
    outputs: [],
  };

  const addContext = (kind: WorkspaceContextEntry["kind"], source: string, text: string): void => {
    workspace.context.push({ id: newId(), kind, source, text, createdAt: Date.now() });
  };

  if (workspace.scratch.size > 0) {
    addContext(
      "finding",
      "shared",
      [...workspace.scratch].map(([name, text]) => `### ${name}\n${text}`).join("\n\n"),
    );
  }

  const baseMessages = async (): Promise<ChatMessageInput[]> => [
    { role: "system", content: agent.systemPrompt },
    ...(await skillContext(agent, skills)),
  ];

  // Fed to every mode's prompt so Plan's output is visible to Execute and
  // Report without a separate channel - "shared context" is just this.
  const contextMessages = (): ChatMessageInput[] => {
    if (workspace.context.length === 0) return [];
    return [
      {
        role: "system",
        content:
          "What's known so far:\n\n" +
          workspace.context.map((e) => `### [${e.kind}] ${e.source}\n${e.text}`).join("\n\n"),
      },
    ];
  };

  let mode: RunMode = "query";
  let transitions = 0;
  let round = 0;
  let answer = "";
  let stoppedBecause: AgentRunResult["stoppedBecause"] = "answered";

  const transitionTo = (to: RunMode, reason: string): EngineEvent => {
    transitions++;
    const from = mode;
    mode = to;
    return { kind: "mode-change", transition: { from, to, reason, round } };
  };

  runLoop: while (true) {
    if (signal?.aborted) {
      stoppedBecause = "aborted";
      emit({ kind: "stopped", text: "Run aborted.", durationMs: 0 });
      break;
    }
    if (transitions > maxModeTransitions) {
      stoppedBecause = "max-transitions";
      emit({ kind: "stopped", text: `Stopped after ${maxModeTransitions} mode changes without finishing.`, durationMs: 0 });
      break;
    }
    if (used >= agent.tokenBudget) {
      stoppedBecause = "token-budget";
      emit({ kind: "stopped", text: `Stopped after using the ${agent.tokenBudget}-token budget.`, durationMs: 0 });
      break;
    }

    // `mode as RunMode`: TS over-narrows a `let` reassigned only inside the
    // transitionTo() closure back to its first-seen literal ("query") across
    // loop iterations - this switch genuinely sees every RunMode value.
    switch (mode as RunMode) {
      case "query": {
        const messages: ChatMessageInput[] = [
          ...(await baseMessages()),
          {
            role: "system",
            content:
              "First, decide: can you answer this directly right now, or do you need to investigate/use tools " +
              "first? If you can answer directly, just answer normally. If you need to research or act first, " +
              "reply with exactly: NEEDS_PLANNING",
          },
          { role: "user", content: input },
        ];
        const started = performance.now();
        let text = "";
        try {
          const result = await chatStream({ model: agent.model, messages, signal, onDelta: (d) => (text += d) });
          used += approxTokens(text);
          if (text.includes("NEEDS_PLANNING")) {
            emit({ kind: "thinking", text: "This needs research or tools - planning first.", model: result.resolvedModel ?? undefined, proxy: result.resolvedProxy, durationMs: performance.now() - started });
            yield transitionTo("plan", "Query decided this needs research or tools.");
          } else {
            answer = text.trim();
            emit({ kind: "answer", text: answer, model: result.resolvedModel ?? undefined, proxy: result.resolvedProxy, durationMs: performance.now() - started });
            break runLoop;
          }
        } catch (err) {
          stoppedBecause = "error";
          emit({ kind: "error", text: err instanceof Error ? err.message : "The model call failed.", durationMs: performance.now() - started });
          break runLoop;
        }
        continue;
      }

      case "plan": {
        const messages: ChatMessageInput[] = [
          ...(await baseMessages()),
          ...contextMessages(),
          {
            role: "system",
            content: "Write a short, ordered plan (numbered steps) for how you'll answer the user's request. Do not execute anything yet - just plan.",
          },
          { role: "user", content: input },
        ];
        const started = performance.now();
        let text = "";
        try {
          const result = await chatStream({ model: agent.model, messages, signal, onDelta: (d) => (text += d) });
          used += approxTokens(text);
          const plan = text.trim();
          emit({ kind: "thinking", text: plan, model: result.resolvedModel ?? undefined, proxy: result.resolvedProxy, durationMs: performance.now() - started });
          workspace.scratch.set("plan", plan);
          addContext("plan", agent.name, plan);
        } catch (err) {
          stoppedBecause = "error";
          emit({ kind: "error", text: err instanceof Error ? err.message : "The model call failed.", durationMs: performance.now() - started });
          break runLoop;
        }
        yield transitionTo("execute", "Plan complete.");
        continue;
      }

      case "execute": {
        round++;
        if (round > agent.maxSteps) {
          yield transitionTo("report", `Stopped after ${agent.maxSteps} execute rounds; reporting best-effort.`);
          continue;
        }

        const messages: ChatMessageInput[] = [...(await baseMessages()), ...contextMessages(), { role: "user", content: input }];
        const started = performance.now();
        let text = "";
        let calls: ToolCallWire[] = [];
        let model: string | null = null;
        let proxy: AgentStep["proxy"];
        try {
          const result = await chatStream({
            model: agent.model,
            messages,
            signal,
            ...(handlers.length > 0 ? { tools: toolDefs(handlers), toolChoice: "auto" as const } : {}),
            onDelta: (d) => (text += d),
          });
          calls = result.toolCalls;
          model = result.resolvedModel;
          proxy = result.resolvedProxy;
        } catch (err) {
          stoppedBecause = "error";
          emit({ kind: "error", text: err instanceof Error ? err.message : "The model call failed.", durationMs: performance.now() - started });
          break runLoop;
        }
        used += approxTokens(text);

        if (calls.length === 0) {
          if (text.trim()) addContext("finding", agent.name, text.trim());
          emit({ kind: "thinking", text: text.trim() || "(ready to report)", model: model ?? undefined, proxy, durationMs: performance.now() - started });
          yield transitionTo("report", "No further tool calls; ready to report.");
          continue;
        }

        if (text.trim()) {
          emit({ kind: "thinking", text: text.trim(), model: model ?? undefined, proxy, durationMs: performance.now() - started });
        }

        for (const call of calls) {
          const toolStarted = performance.now();
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            /* a malformed argument object is reported to the model as an empty call */
          }
          const result =
            call.function.name === "call_agent" && delegate
              ? await delegate.run(args, ctx).catch((e: unknown) => `call_agent failed: ${String(e)}`)
              : await runTool(call.function.name, args, ctx, handlers);
          used += approxTokens(result);
          emit({ kind: "tool", tool: call.function.name, args, result, durationMs: performance.now() - toolStarted });
          // Truncated here (unlike the untruncated step trace above) - this is
          // what re-enters every later prompt, so it must stay bounded.
          addContext("finding", agent.name, `Called ${call.function.name}: ${result.slice(0, 2000)}`);
        }
        continue;
      }

      case "report": {
        const messages: ChatMessageInput[] = [
          ...(await baseMessages()),
          ...contextMessages(),
          { role: "system", content: "Write the final answer to the user's request, using everything gathered above. Do not call any tools." },
          { role: "user", content: input },
        ];
        const started = performance.now();
        let text = "";
        try {
          const result = await chatStream({ model: agent.model, messages, signal, onDelta: (d) => (text += d) });
          used += approxTokens(text);
          answer = text.trim();
          emit({ kind: "answer", text: answer, model: result.resolvedModel ?? undefined, proxy: result.resolvedProxy, durationMs: performance.now() - started });
        } catch (err) {
          stoppedBecause = "error";
          emit({ kind: "error", text: err instanceof Error ? err.message : "The model call failed.", durationMs: performance.now() - started });
        }
        break runLoop;
      }
    }
  }

  const result: AgentRunResult = { steps, answer, stoppedBecause, approxTokens: used };
  if (answer) yield { kind: "answer-final", text: answer };
  yield { kind: "done", result };
  return result;
}
