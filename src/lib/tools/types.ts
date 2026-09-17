import type { ToolDef } from "../gateway/types";
import type { Skill, SkillResource } from "../skills";

/**
 * The tool layer.
 *
 * The tool loop used to be hardcoded to two skill functions inside App.tsx.
 * Browser use, code execution, plugin-contributed tools and agents all need to
 * add their own, so tools are registered here instead and the loop simply asks
 * the registry which ones apply to the current turn.
 */

/** What a tool can see about the turn it is running in. */
export interface ToolContext {
  convoId: string;
  signal?: AbortSignal;
  /** Skills active in this conversation, by skill id, with their resources. */
  activeSkills: Map<string, { resources?: SkillResource[] }>;
  /** Every skill the user has, for name/slug resolution. */
  skills: Skill[];
  /** Progress/telemetry for surfaces that show a live trace (the agent runner). */
  onEvent?: (event: ToolEvent) => void;
}

export interface ToolEvent {
  tool: string;
  phase: "start" | "end" | "error";
  args?: Record<string, unknown>;
  result?: string;
  message?: string;
}

export interface ToolHandler {
  /** Stable id, matching `def.function.name`. */
  id: string;
  /** Grouping for the agent builder UI. */
  group: "skills" | "browser" | "code" | "web" | "fs" | "plugin";
  def: ToolDef;
  /**
   * Whether this tool should be offered on this turn. Skill tools only apply
   * when a skill is active; browser tools only when the user enabled them.
   */
  applies(ctx: ToolContext): boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** Convenience for the common "string argument" read. */
export function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}
