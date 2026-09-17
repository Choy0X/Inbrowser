import { chatStream, type ChatMessageInput } from "./onniroute";
import type { ToolCallWire } from "./gateway/types";
import { runTool, toolById, toolDefs, type ToolContext } from "./tools/registry";
import type { ToolHandler } from "./tools/types";
import { getSkillResources } from "./skillstore";
import { truncateResourceText, type Skill } from "./skills";
import { MAX_AGENT_DEPTH, type Agent } from "./agents";

/**
 * The agent loop: plan, act, observe, repeat until the agent answers or runs
 * out of budget.
 *
 * Deliberately bounded. An unbounded loop over free, rate-limited models is a
 * good way to burn a user's quota and produce nothing, so every run has a step
 * cap, a token budget and an abort signal, and every stopping reason is
 * reported rather than silently swallowed.
 */

export type AgentStepKind = "thinking" | "tool" | "answer" | "error" | "stopped";

export interface AgentStep {
  proxy?: import("./types").ResponseProxy | null;
  index: number;
  kind: AgentStepKind;
  /** Assistant text for "thinking"/"answer", message for "error"/"stopped". */
  text?: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
  model?: string;
  durationMs: number;
  /** Depth in the agent -> sub-agent chain; 0 for the agent the user started. */
  depth: number;
  agentName: string;
}

export interface AgentRunResult {
  steps: AgentStep[];
  answer: string;
  stoppedBecause:
    | "answered"
    | "max-steps"
    | "token-budget"
    | "aborted"
    | "error"
    // workflow mode (agentEngine/workflowLoop.ts)
    | "max-transitions"
    // swarm mode (agentEngine/swarmLoop.ts)
    | "max-rounds"
    | "wall-clock"
    | "diminishing-returns";
  approxTokens: number;
}

export interface RunAgentOptions {
  agent: Agent;
  input: string;
  agents: Agent[];
  skills: Skill[];
  signal?: AbortSignal;
  onStep?: (step: AgentStep) => void;
  /** Shared scratchpad, so a team of agents can pass findings along. */
  scratchpad?: Map<string, string>;
  depth?: number;
}

/** Rough token estimate; only used to enforce a budget, never billed against. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Exported so agentEngine's workflow/swarm loops can build the same skill context without duplicating it. */
export async function skillContext(agent: Agent, skills: Skill[]): Promise<ChatMessageInput[]> {
  const messages: ChatMessageInput[] = [];
  for (const skillId of agent.skillIds) {
    const skill = skills.find((s) => s.id === skillId);
    if (!skill) continue;
    const resources = await getSkillResources(skill.id).catch(() => []);
    const parts = [skill.instructions];
    if (resources.length > 0) {
      const texts = resources
        .filter((r) => r.kind === "text" && r.text)
        .map((r) => `--- ${r.path} ---\n${truncateResourceText(r.text!)}`);
      parts.push(
        `This skill ships with these files:\n${resources.map((r) => r.path).join("\n")}` +
          (texts.length > 0 ? `\n\nTheir contents:\n\n${texts.join("\n\n")}` : "")
      );
    }
    messages.push({ role: "system", content: `Skill "${skill.name}":\n\n${parts.join("\n\n")}` });
  }
  return messages;
}

/**
 * A tool that lets one agent delegate to another. Built per-run so it only ever
 * offers the sub-agents this agent actually declares, and so the depth cap
 * travels with it.
 */
/** Exported so agentEngine's workflow loop can offer the same delegation tool. */
export function callAgentTool(options: RunAgentOptions, depth: number): ToolHandler | null {
  const { agent, agents } = options;
  const subAgents = agent.subAgentIds
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is Agent => Boolean(a));

  if (subAgents.length === 0 || depth >= MAX_AGENT_DEPTH) return null;

  return {
    id: "call_agent",
    group: "plugin",
    applies: () => true,
    def: {
      type: "function",
      function: {
        name: "call_agent",
        description:
          "Delegate a self-contained sub-task to another agent and get its final answer back. " +
          `Available agents: ${subAgents.map((a) => `"${a.name}" (${a.description || "no description"})`).join("; ")}.`,
        parameters: {
          type: "object",
          properties: {
            agent: { type: "string", description: "Name of the agent to delegate to." },
            task: { type: "string", description: "The complete, self-contained task for that agent." },
          },
          required: ["agent", "task"],
        },
      },
    },
    async run(args) {
      const wanted = typeof args.agent === "string" ? args.agent.toLowerCase().trim() : "";
      const task = typeof args.task === "string" ? args.task : "";
      const target = subAgents.find((a) => a.name.toLowerCase() === wanted)
        ?? subAgents.find((a) => a.name.toLowerCase().includes(wanted));
      if (!target) {
        return `No such sub-agent. Available: ${subAgents.map((a) => a.name).join(", ")}.`;
      }
      if (!task.trim()) return "Provide a task for the sub-agent.";

      const result = await runAgent({
        ...options,
        agent: target,
        input: task,
        depth: depth + 1,
        onStep: options.onStep,
      });
      options.scratchpad?.set(target.name, result.answer);
      return result.answer || `(${target.name} produced no answer; it stopped because: ${result.stoppedBecause})`;
    },
  };
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const { agent, input, skills, signal, onStep } = options;
  const depth = options.depth ?? 0;
  const scratchpad = options.scratchpad ?? new Map<string, string>();

  const steps: AgentStep[] = [];
  let stepIndex = 0;
  let used = 0;

  const emit = (step: Omit<AgentStep, "index" | "depth" | "agentName">) => {
    const full: AgentStep = { ...step, index: stepIndex++, depth, agentName: agent.name };
    steps.push(full);
    onStep?.(full);
  };

  // Assemble the toolset: what the agent declares, plus delegation when it has
  // sub-agents. An unknown id is skipped rather than failing the run - a tool
  // may come from a plugin the user has since removed.
  const handlers: ToolHandler[] = agent.toolIds
    .map((id) => toolById(id))
    .filter((h): h is ToolHandler => Boolean(h));
  const delegate = callAgentTool(options, depth);
  if (delegate) handlers.push(delegate);

  const ctx: ToolContext = {
    convoId: `agent:${agent.id}`,
    signal,
    activeSkills: new Map(),
    skills,
  };

  const messages: ChatMessageInput[] = [
    { role: "system", content: agent.systemPrompt },
    ...(await skillContext(agent, skills)),
  ];

  if (scratchpad.size > 0) {
    messages.push({
      role: "system",
      content:
        "Findings from other agents on this task:\n\n" +
        [...scratchpad].map(([name, text]) => `### ${name}\n${text}`).join("\n\n"),
    });
  }
  messages.push({ role: "user", content: input });

  let answer = "";
  let stoppedBecause: AgentRunResult["stoppedBecause"] = "answered";

  for (let round = 0; ; round++) {
    if (signal?.aborted) {
      stoppedBecause = "aborted";
      emit({ kind: "stopped", text: "Run aborted.", durationMs: 0 });
      break;
    }
    if (round >= agent.maxSteps) {
      stoppedBecause = "max-steps";
      emit({ kind: "stopped", text: `Stopped after ${agent.maxSteps} steps without finishing.`, durationMs: 0 });
      break;
    }
    if (used >= agent.tokenBudget) {
      stoppedBecause = "token-budget";
      emit({ kind: "stopped", text: `Stopped after using the ${agent.tokenBudget}-token budget.`, durationMs: 0 });
      break;
    }

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
        ...(handlers.length > 0 ? { tools: toolDefs(handlers), toolChoice: "auto" } : {}),
        onDelta: (delta) => {
          text += delta;
        },
      });
      calls = result.toolCalls;
      model = result.resolvedModel;
      proxy = result.resolvedProxy;
    } catch (err) {
      const message = err instanceof Error ? err.message : "The model call failed.";
      stoppedBecause = "error";
      emit({ kind: "error", text: message, durationMs: performance.now() - started });
      break;
    }

    used += approxTokens(text);

    if (calls.length === 0) {
      answer = text.trim();
      emit({ kind: "answer", text: answer, model: model ?? undefined, proxy, durationMs: performance.now() - started });
      break;
    }

    if (text.trim()) {
      emit({ kind: "thinking", text: text.trim(), model: model ?? undefined, proxy, durationMs: performance.now() - started });
    }

    messages.push({ role: "assistant", content: text, tool_calls: calls });

    for (const call of calls) {
      const toolStarted = performance.now();
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        /* a malformed argument object is reported to the model as an empty call */
      }

      // Delegation is per-run, so it isn't in the global registry.
      const result =
        call.function.name === "call_agent" && delegate
          ? await delegate.run(args, ctx).catch((e: unknown) => `call_agent failed: ${String(e)}`)
          : await runTool(call.function.name, args, ctx, handlers);

      used += approxTokens(result);
      emit({
        kind: "tool",
        tool: call.function.name,
        args,
        result,
        durationMs: performance.now() - toolStarted,
      });
      messages.push({ role: "tool", content: result, tool_call_id: call.id });
    }
  }

  return { steps, answer, stoppedBecause, approxTokens: used };
}
