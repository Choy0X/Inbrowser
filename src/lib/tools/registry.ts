import type { ToolDef } from "../gateway/types";
import type { ToolContext, ToolHandler } from "./types";
import { SKILL_TOOL_HANDLERS } from "./skillTools";
import { BROWSER_TOOL_HANDLERS } from "./browserTools";
import { CODE_TOOL_HANDLERS } from "./codeTools";
import { FS_TOOL_HANDLERS } from "./fsTools";
import { WEB_TOOL_HANDLERS } from "./webTools";
import { DATA_CONNECTOR_TOOL_HANDLERS } from "./dataConnectorTools";
import { argumentError } from "../gateway/toolValidation";

export type { ToolContext, ToolHandler, ToolEvent } from "./types";

/**
 * Every tool the model can be offered, in one place.
 *
 * The chat loop asks for the tools that apply to the current turn; the agent
 * runner asks for a specific set by id. Adding a tool anywhere in the app means
 * appending a handler here rather than editing App.tsx.
 */
const HANDLERS: ToolHandler[] = [
  ...SKILL_TOOL_HANDLERS,
  ...BROWSER_TOOL_HANDLERS,
  ...CODE_TOOL_HANDLERS,
  ...FS_TOOL_HANDLERS,
  ...WEB_TOOL_HANDLERS,
  ...DATA_CONNECTOR_TOOL_HANDLERS,
];

/** Tools contributed at runtime by installed plugins (see lib/plugins). */
const dynamicHandlers = new Map<string, ToolHandler>();

export function registerTool(handler: ToolHandler): void {
  dynamicHandlers.set(handler.id, handler);
}

export function unregisterTool(id: string): void {
  dynamicHandlers.delete(id);
}

export function allTools(): ToolHandler[] {
  return [...HANDLERS, ...dynamicHandlers.values()];
}

export function toolById(id: string): ToolHandler | undefined {
  return allTools().find((h) => h.id === id);
}

export interface ToolSelection {
  /** Tool ids the user/agent has explicitly enabled beyond the always-on ones. */
  enabledIds?: string[];
}

/**
 * The tools to offer on this turn.
 *
 * Skill tools switch themselves on whenever a skill is active. Everything else
 * is opt-in: a model should not be handed the ability to fetch arbitrary URLs
 * or execute code unless the user asked for it.
 */
export function toolsForTurn(ctx: ToolContext, selection: ToolSelection = {}): ToolHandler[] {
  const enabled = new Set(selection.enabledIds ?? []);
  return allTools().filter(
    (h) => (h.group === "skills" ? h.applies(ctx) : enabled.has(h.id) && h.applies(ctx))
  );
}

export function toolDefs(handlers: ToolHandler[]): ToolDef[] {
  return handlers.map((h) => h.def);
}

/**
 * Run one tool call. Never throws: a tool failure is reported back to the model
 * as text so it can adapt, rather than aborting the whole turn.
 *
 * `offered` is the turn's actual toolset (App.tsx's turnTools, agentRunner.ts's
 * handlers) - passed through so an unrecognized name gets a corrective answer
 * (what's really callable) instead of a dead end. A model that tried calling
 * <fachoy-artifact> as if it were a tool once narrated "the system is saying
 * it's an unknown tool" and gave up rather than retrying with run_code; a bare
 * "Unknown tool" string gave it nothing to recover with.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  offered?: ToolHandler[],
): Promise<string> {
  const handler = toolById(name);
  if (offered && !offered.some(tool => tool.id === name)) return `Tool "${name}" is not available this turn. Use only the offered tools or answer directly.`;
  if (!handler) {
    const available = (offered ?? allTools()).map((h) => h.id);
    const hint =
      available.length > 0 ? ` Tools available this turn: ${available.join(", ")}.` : " No tools are available this turn.";
    const artifactNote = /artifact/i.test(name)
      ? ' To create a file, write a <fachoy-artifact id="..." type="..." title="..."> tag directly in your reply now - continue without mentioning this message.'
      : "";
    return `Unknown tool "${name}".${hint}${artifactNote}`;
  }

  const validationError = argumentError(args, handler.def.function.parameters);
  if (validationError) return `Tool "${name}" was not run: ${validationError}.`;
  ctx.onEvent?.({ tool: name, phase: "start", args });
  try {
    const result = await handler.run(args, ctx);
    ctx.onEvent?.({ tool: name, phase: "end", result });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool failed.";
    ctx.onEvent?.({ tool: name, phase: "error", message });
    return `Tool "${name}" failed: ${message}`;
  }
}
