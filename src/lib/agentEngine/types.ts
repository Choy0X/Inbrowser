import type { ToolHandler } from "../tools/types";
import type { AgentStep, AgentRunResult } from "../agentRunner";

export type { AgentStep, AgentStepKind, AgentRunResult, RunAgentOptions } from "../agentRunner";

/**
 * The four-phase run loop a "workflow" agent moves through. A "simple" agent
 * (today's flat tool-calling loop) never enters this state machine at all -
 * these modes only apply once Agent.mode is "workflow" or "swarm".
 */
export type RunMode = "query" | "plan" | "execute" | "report";

export interface ModeTransition {
  from: RunMode;
  to: RunMode;
  /** Always populated - mirrors AgentRunResult.stoppedBecause's "always say why". */
  reason: string;
  round: number;
}

/** One thing the run knows: an answer draft, an artifact, a finding, a plan. */
export interface WorkspaceContextEntry {
  id: string;
  kind: "answer" | "artifact" | "finding" | "plan";
  /** Agent name that produced it, or "self". */
  source: string;
  text: string;
  createdAt: number;
}

export interface WorkspaceOutput {
  id: string;
  kind: "file" | "data" | "text";
  /** VFS path, only for kind "file". */
  path?: string;
  mimeType?: string;
  text?: string;
  createdAt: number;
}

/** The five workspace facets: Tools, Question, Context, Scratch, Outputs. */
export interface Workspace {
  tools: ToolHandler[];
  question: string;
  context: WorkspaceContextEntry[];
  scratch: Map<string, string>;
  outputs: WorkspaceOutput[];
}

export type EngineEvent =
  | { kind: "step"; step: AgentStep }
  | { kind: "mode-change"; transition: ModeTransition }
  | { kind: "answer-draft"; text: string }
  | { kind: "answer-final"; text: string }
  | { kind: "swarm-lane"; memberId: string; memberName: string; event: EngineEvent }
  | { kind: "done"; result: AgentRunResult };
