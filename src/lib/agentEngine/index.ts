import type { RunAgentOptions, AgentRunResult } from "../agentRunner";
import type { EngineEvent } from "./types";
import { simpleLoop } from "./simpleLoop";
import { workflowLoop } from "./workflowLoop";
import { swarmLoop } from "./swarmLoop";

export type {
  EngineEvent,
  RunMode,
  ModeTransition,
  Workspace,
  WorkspaceContextEntry,
  WorkspaceOutput,
  AgentStep,
  AgentStepKind,
  AgentRunResult,
  RunAgentOptions,
} from "./types";

/** Dispatches a run by the agent's mode. */
export async function* runAgentStream(options: RunAgentOptions): AsyncGenerator<EngineEvent, AgentRunResult> {
  const mode = options.agent.mode ?? "simple";
  if (mode === "workflow") return yield* workflowLoop(options);
  if (mode === "swarm") return yield* swarmLoop(options);
  return yield* simpleLoop(options);
}

/** Promise-based wrapper for callers that don't need the live event stream. */
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  let result: AgentRunResult | undefined;
  for await (const ev of runAgentStream(options)) {
    if (ev.kind === "done") result = ev.result;
  }
  return result!;
}
